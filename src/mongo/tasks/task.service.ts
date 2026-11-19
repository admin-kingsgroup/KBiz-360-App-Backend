import { Types } from 'mongoose';
import { BadRequest, Forbidden, NotFound } from '../../common/errors';
import { accessService, type MongoAccess } from '../access';
import { crmRepo } from '../crm.repo';
import { chatService } from '../chat/chat.service';
import { emitToUsers } from '../chat/chat.events';
import type { TaskDoc } from './task.model';
import { taskRepo, type HistoryRow } from './task.repository';
import { taskPeople, unknownPerson, type TaskPerson } from './task.people';
import { taskNotify, type TaskEvent } from './task.notify';
import { shareTaskInBranchGroup } from './task.groupPost';
import { ALERTS_CLEARED, isOverdue, planTransition } from './task.rules';
import { branchNames, toHistoryDTOs, toTaskDTOs, type TaskDTO } from './task.dto';
import { DAY_KEY_RE, HHMM_RE, localParts, longDate, nextOccurrence, shortStamp, zonedDateTime } from './task.time';
import {
  DEFAULT_DUE_TIME, DESCRIPTION_MAX, FINAL_STATUSES, LIVE_STATUSES, OPEN_STATUSES, STATUS_LABEL, TITLE_MAX,
  DEPARTMENT_LABEL, type RepeatRule, type TaskDepartment, type TaskPriority, type TaskStatus,
} from './task.types';

// Smart Connect Tasks (spec 2026-11-16 + the owner's answers): anyone may assign anyone; a manager sees
// the tasks of the people below them (Super Admin sees all); no escalation. The task chat is started
// from inside the task by its giver, assignee or a watcher, and closes (off every list, read-only) with the task.

export const TASK_EVENT = 'task:update'; // socket event: { taskId } — lists and details refetch

export interface DueInput { dueAt?: string | null; dueDate?: string | null; dueTime?: string | null }
export interface AttachmentInput { url: string; name: string; size: number; mime: string }
export interface CreateInput extends DueInput {
  title: string;
  description?: string;
  assignedTo: string;
  watcherIds?: string[];
  branchId: string;
  companyId?: string | null;
  priority: TaskPriority;
  department?: TaskDepartment | null; // Operations / Accounts — the branch group it is shared in
  attachments?: AttachmentInput[];
  repeat?: RepeatRule;
  link?: { label: string; url: string } | null;
  source?: 'app' | 'erp';
}
export interface PatchInput extends DueInput {
  title?: string;
  description?: string;
  priority?: TaskPriority;
  department?: TaskDepartment | null;
  branchId?: string;
  repeat?: RepeatRule;
  link?: { label: string; url: string } | null;
  comment?: string;
}
export type ListView = 'mine' | 'assigned' | 'watching' | 'team' | 'all';
export interface ListQuery {
  view: ListView;
  state?: 'open' | 'closed' | 'all';
  status?: TaskStatus[];
  priority?: TaskPriority;
  branchId?: string;
  companyId?: string;
  personId?: string;
  dueFrom?: string;
  dueTo?: string;
  q?: string;
  flag?: 'overdue' | 'due_today' | 'waiting_check';
  closedFrom?: string; // closed on/after this instant (the dashboard's "closed this month")
}

export const ATTACHMENT_MAX_BYTES = 20 * 1024 * 1024; // spec §5: files up to 20 MB

// ── small helpers ──
const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const isoOrNull = (d: Date | null | undefined): string | null => (d ? new Date(d).toISOString() : null);
const sameRepeat = (a: RepeatRule | undefined, b: RepeatRule | undefined): boolean => JSON.stringify(a ?? { kind: 'none' }) === JSON.stringify(b ?? { kind: 'none' });

function cleanTitle(title: string): string {
  const t = title.trim();
  if (!t) throw BadRequest('A title is required');
  if (t.length > TITLE_MAX) throw BadRequest(`Keep the title to ${TITLE_MAX} characters`);
  return t;
}
function cleanDescription(d: string | undefined): string {
  const t = (d ?? '').trim();
  if (t.length > DESCRIPTION_MAX) throw BadRequest(`Keep the description to ${DESCRIPTION_MAX.toLocaleString('en-US')} characters`);
  return t;
}
function cleanRepeat(r: RepeatRule | undefined): RepeatRule {
  if (!r || r.kind === 'none') return { kind: 'none' };
  if (r.kind === 'daily') return { kind: 'daily' };
  if (r.kind === 'weekly') {
    const days = [...new Set(r.days ?? [])].filter((d) => Number.isInteger(d) && d >= 0 && d <= 6).sort();
    if (!days.length) throw BadRequest('Pick at least one day for a weekly repeat');
    return { kind: 'weekly', days };
  }
  if (r.kind === 'monthly') {
    const dom = Math.floor(r.dayOfMonth);
    if (!(dom >= 1 && dom <= 31)) throw BadRequest('Pick a date from 1 to 31 for a monthly repeat');
    return { kind: 'monthly', dayOfMonth: dom };
  }
  throw BadRequest('Unknown repeat');
}

// The due instant: an explicit ISO time, or a calendar day (+ optional time, default 6 pm) read in the
// assignee's zone. Null when nothing was given.
export function resolveDue(input: DueInput, tz: string): Date | null {
  if (input.dueAt) {
    const d = new Date(input.dueAt);
    if (Number.isNaN(d.getTime())) throw BadRequest('The due date is not a valid date');
    return d;
  }
  if (input.dueDate) {
    if (!DAY_KEY_RE.test(input.dueDate)) throw BadRequest('The due date must be YYYY-MM-DD');
    const time = input.dueTime || DEFAULT_DUE_TIME;
    if (!HHMM_RE.test(time)) throw BadRequest('The due time must be HH:mm');
    return zonedDateTime(input.dueDate, time, tz);
  }
  return null;
}
const hasDue = (i: DueInput): boolean => i.dueAt !== undefined || i.dueDate !== undefined;

async function companyOfBranch(branchId: string): Promise<string | null> {
  if (!Types.ObjectId.isValid(branchId)) throw BadRequest('Pick a business / branch');
  const branch = (await crmRepo.branchesByIds([new Types.ObjectId(branchId)]))[0];
  if (!branch) throw BadRequest('That branch does not exist');
  return branch.company_id ? String(branch.company_id) : null;
}

// Who sees a task: its people, a Super Admin, or anyone above the assignee in the hierarchy
// (strictly higher role level, sharing a branch, or company-wide for level ≤ 2).
export function canView(task: Pick<TaskDoc, 'assignedBy' | 'assignedTo' | 'watchers'>, viewerId: string, viewer: MongoAccess | null, assignee: TaskPerson | null): boolean {
  if (task.assignedBy === viewerId || task.assignedTo === viewerId || task.watchers.some((w) => w.userId === viewerId)) return true;
  if (!viewer) return false;
  if (viewer.isSuper) return true;
  if (!assignee) return false;
  return accessService.canSee(viewer, { level: assignee.level, branchIds: assignee.branchIds });
}

const isParty = (t: TaskDoc, userId: string): boolean => t.assignedBy === userId || t.assignedTo === userId || t.watchers.some((w) => w.userId === userId);
const chatMembersOf = (t: Pick<TaskDoc, 'assignedBy' | 'assignedTo' | 'watchers'>): string[] => [...new Set([t.assignedBy, t.assignedTo, ...t.watchers.map((w) => w.userId)])];
const partiesOf = (t: TaskDoc): string[] => chatMembersOf(t);

async function loadVisible(actorId: string, id: string): Promise<{ task: TaskDoc; viewer: MongoAccess | null }> {
  const task = await taskRepo.byId(id);
  if (!task) throw NotFound('Task not found');
  if (isParty(task, actorId)) return { task, viewer: null };
  const viewer = await accessService.accessForUserId(actorId);
  const assignee = await taskPeople.one(task.assignedTo);
  if (!canView(task, actorId, viewer, assignee)) throw NotFound('Task not found');
  return { task, viewer };
}

// Users whose tasks the viewer sees through the hierarchy (null = everyone, for a Super Admin).
async function teamOf(actorId: string): Promise<string[] | null> {
  const viewer = await accessService.accessForUserId(actorId);
  if (!viewer) return [];
  if (viewer.isSuper) return null;
  const users = await crmRepo.listUsers({});
  const people = await taskPeople.resolve(users.map((u) => String(u._id)));
  return [...people.values()].filter((p) => p.id !== actorId && accessService.canSee(viewer, { level: p.level, branchIds: p.branchIds })).map((p) => p.id);
}

function statusFilter(state: ListQuery['state'], status?: TaskStatus[]): Record<string, unknown> {
  if (status?.length) return { status: { $in: status } };
  if (state === 'closed') return { status: { $in: FINAL_STATUSES } };
  if (state === 'all') return {};
  return { status: { $in: LIVE_STATUSES } };
}

async function notice(task: TaskDoc, actorId: string, text: string): Promise<void> {
  if (task.chatId) await chatService.postTaskNotice(task.chatId, actorId, text);
}
function announce(task: TaskDoc, extra: string[] = []): void {
  emitToUsers([...partiesOf(task), ...extra], TASK_EVENT, { taskId: String(task._id) });
  // The task chat's row (name, taskStatus) changes with the task — chat lists refetch it.
  if (task.chatId && !FINAL_STATUSES.includes(task.status)) emitToUsers(chatMembersOf(task), 'chat:conversationUpdated', { conversationId: task.chatId });
}
async function notify(event: TaskEvent, task: TaskDoc, recipients: string[], ctx: Parameters<typeof taskNotify.send>[3] = {}): Promise<void> {
  try { await taskNotify.send(event, task, recipients, ctx); } catch { /* notifications are best-effort */ }
}

async function dto(task: TaskDoc, viewerId: string): Promise<TaskDTO> {
  return (await toTaskDTOs([task], viewerId))[0];
}

// ── the service ──
export const tasksService = {
  // POST /tasks — creates the task and its chat, then tells the assignee.
  async create(actorId: string, input: CreateInput, opts: { now?: Date; parentRecurringId?: string | null; allowPast?: boolean } = {}): Promise<TaskDTO> {
    const now = opts.now ?? new Date();
    const title = cleanTitle(input.title);
    const description = cleanDescription(input.description);
    const people = await taskPeople.resolve([actorId, input.assignedTo, ...(input.watcherIds ?? [])]);
    const assignee = people.get(input.assignedTo);
    if (!assignee) throw BadRequest('Pick who the task is for');
    const companyId = await companyOfBranch(input.branchId);
    if (input.companyId && companyId && input.companyId !== companyId) throw BadRequest('That branch does not belong to the selected business');
    const dueAt = resolveDue(input, assignee.tz);
    if (!dueAt) throw BadRequest('A due date is required');
    if (!opts.allowPast && dueAt.getTime() <= now.getTime()) throw BadRequest('The due date cannot be in the past');
    const self = actorId === input.assignedTo;
    const watcherIds = [...new Set(input.watcherIds ?? [])].filter((w) => w !== actorId && w !== input.assignedTo && people.has(w));
    for (const a of input.attachments ?? []) if (a.size > ATTACHMENT_MAX_BYTES) throw BadRequest(`"${a.name}" is over 20 MB`);

    const task = await taskRepo.create({
      title,
      description,
      companyId: companyId ?? input.companyId ?? null,
      branchId: input.branchId,
      assignedTo: input.assignedTo,
      assignedBy: actorId,
      watchers: watcherIds.map((userId) => ({ userId, addedBy: actorId, addedAt: now })),
      priority: input.priority,
      department: input.department ?? null,
      dueAt,
      status: self ? 'accepted' : 'assigned',
      attachments: (input.attachments ?? []).map((a) => ({ ...a, uploadedBy: actorId, uploadedAt: now })),
      repeat: cleanRepeat(input.repeat),
      parentRecurringId: opts.parentRecurringId ?? null,
      link: input.link ?? null,
      source: input.source ?? 'app',
      assignedAt: now,
      acceptedAt: self ? now : null,
    });
    const taskId = String(task._id);
    const saved = task; // no chat yet — the giver, the assignee or a watcher starts one from inside the task
    await taskRepo.addHistory([{ taskId, userId: actorId, field: 'created', newValue: title }]);
    await notify('assigned', saved, [saved.assignedTo], { actorId });
    if (watcherIds.length) await notify('watcher_added', saved, watcherIds, { actorId });
    // The branch's Operations / Accounts group hears of it once — not a personal to-do, not each repeat copy.
    if (saved.department && !self && !opts.parentRecurringId) await shareTaskInBranchGroup(saved, people);
    announce(saved);
    return dto(saved, actorId);
  },

  // GET /tasks?view=… — the three lists (+ Team for managers, All for the dashboard drill-down).
  async list(actorId: string, q: ListQuery, now = new Date()): Promise<TaskDTO[]> {
    const and: Record<string, unknown>[] = [statusFilter(q.state, q.status)];
    if (q.view === 'mine') and.push({ assignedTo: actorId });
    else if (q.view === 'assigned') and.push({ assignedBy: actorId, assignedTo: { $ne: actorId } });
    else if (q.view === 'watching') and.push({ 'watchers.userId': actorId });
    else {
      const team = await teamOf(actorId);
      const mineOrTeam: Record<string, unknown>[] = [{ assignedTo: actorId }, { assignedBy: actorId }, { 'watchers.userId': actorId }];
      if (q.view === 'team') {
        if (team === null) and.push({ assignedTo: { $ne: actorId }, assignedBy: { $ne: actorId }, 'watchers.userId': { $ne: actorId } });
        else and.push({ assignedTo: { $in: team }, assignedBy: { $ne: actorId }, 'watchers.userId': { $ne: actorId } });
      } else if (team !== null) {
        and.push({ $or: [...mineOrTeam, { assignedTo: { $in: team } }] });
      }
    }
    if (q.priority) and.push({ priority: q.priority });
    if (q.branchId) and.push({ branchId: q.branchId });
    if (q.companyId) and.push({ companyId: q.companyId });
    if (q.personId) and.push({ $or: [{ assignedTo: q.personId }, { assignedBy: q.personId }] });
    if (q.dueFrom || q.dueTo) {
      const range: Record<string, Date> = {};
      if (q.dueFrom) range.$gte = new Date(q.dueFrom);
      if (q.dueTo) range.$lte = new Date(q.dueTo);
      and.push({ dueAt: range });
    }
    if (q.closedFrom) and.push({ closedAt: { $gte: new Date(q.closedFrom) } });
    if (q.q?.trim()) and.push({ title: { $regex: escapeRegex(q.q.trim()), $options: 'i' } });
    if (q.flag === 'overdue') and.push({ status: { $in: OPEN_STATUSES }, dueAt: { $lt: now } });
    if (q.flag === 'waiting_check') and.push({ status: 'done', assignedBy: actorId });
    let tasks = await taskRepo.find(and.length === 1 ? and[0] : { $and: and });
    if (q.flag === 'due_today') {
      const viewer = await taskPeople.one(actorId);
      const tz = viewer?.tz ?? unknownPerson(actorId).tz;
      const today = localParts(now, tz).dayKey;
      tasks = tasks.filter((t) => OPEN_STATUSES.includes(t.status) && t.dueAt && localParts(t.dueAt, tz).dayKey === today);
    }
    // Undated (converted) tasks sort last; closed lists read most-recently-finished first.
    if (q.state === 'closed') tasks.sort((a, b) => (b.closedAt ?? b.cancelledAt ?? b.updatedAt).getTime() - (a.closedAt ?? a.cancelledAt ?? a.updatedAt).getTime());
    else tasks.sort((a, b) => (a.dueAt?.getTime() ?? Number.MAX_SAFE_INTEGER) - (b.dueAt?.getTime() ?? Number.MAX_SAFE_INTEGER));
    return toTaskDTOs(tasks, actorId, now);
  },

  // GET /tasks/:id — detail with the full history.
  async get(actorId: string, id: string) {
    const { task } = await loadVisible(actorId, id);
    return { task: await dto(task, actorId), history: await toHistoryDTOs(await taskRepo.history(String(task._id))) };
  },

  // POST /tasks/:id/status — the §4 machine, enforced here for every client.
  async changeStatus(actorId: string, id: string, input: { to: TaskStatus; comment?: string | null } & DueInput, now = new Date()): Promise<TaskDTO> {
    const { task } = await loadVisible(actorId, id);
    const people = await taskPeople.resolve([actorId, task.assignedTo]);
    const actor = people.get(actorId) ?? unknownPerson(actorId);
    const assigneeTz = (people.get(task.assignedTo) ?? unknownPerson(task.assignedTo)).tz;
    const dueAt = hasDue(input) ? resolveDue(input, assigneeTz) : null;
    const plan = planTransition(task, actorId, input.to, { comment: input.comment, dueAt }, now);
    const updated = await taskRepo.update(String(task._id), { $set: plan.set }, { status: task.status });
    if (!updated) throw BadRequest('The task changed while you were looking at it — refresh and try again');
    const comment = input.comment?.trim() || null;
    const rows: HistoryRow[] = [{ taskId: id, userId: actorId, field: 'status', oldValue: task.status, newValue: plan.status, comment }];
    if (plan.set.dueAt) rows.push({ taskId: id, userId: actorId, field: 'dueAt', oldValue: isoOrNull(task.dueAt), newValue: isoOrNull(plan.set.dueAt as Date) });
    await taskRepo.addHistory(rows);

    const stamp = shortStamp(now, actor.tz);
    const reason = comment ? ` — ${comment}` : '';
    let line: string;
    if (plan.status === 'closed') line = `Task closed by ${actor.name} on ${longDate(now, actor.tz)}.`;
    else if (plan.status === 'cancelled') line = `Task cancelled by ${actor.name} on ${longDate(now, actor.tz)}. Reason: ${comment}`;
    else if (plan.status === 'date_change_requested') line = `${actor.name} asked to move the due date to ${shortStamp(dueAt as Date, assigneeTz)}${reason} · ${stamp}`;
    else if (task.status === 'date_change_requested' && plan.status === 'accepted') line = `${actor.name} set the due date to ${shortStamp(updated.dueAt as Date, assigneeTz)} · ${stamp}`;
    else line = `${actor.name} marked this ${STATUS_LABEL[plan.status]}${reason} · ${stamp}`;
    // Reopened: the chat comes back first, so the notice lands in a live chat. Closed / Cancelled: the
    // notice is the chat's last line, then it leaves everyone's list and turns read-only.
    if (plan.status === 'reopened' && updated.chatId) await chatService.reopenTaskChat(updated.chatId);
    await notice(updated, actorId, line);
    if (FINAL_STATUSES.includes(plan.status) && updated.chatId) await chatService.closeTaskChat(updated.chatId);

    const watchers = updated.watchers.map((w) => w.userId);
    if (task.status === 'date_change_requested' && plan.status === 'accepted') await notify('due_changed', updated, [updated.assignedTo], { actorId });
    else if (['accepted', 'date_change_requested', 'waiting', 'done'].includes(plan.status)) await notify(plan.status as TaskEvent, updated, [updated.assignedBy], { actorId, comment });
    else if (['closed', 'reopened', 'cancelled'].includes(plan.status)) await notify(plan.status as TaskEvent, updated, [updated.assignedTo, ...watchers], { actorId, comment });

    if (plan.status === 'closed' && updated.repeat?.kind && updated.repeat.kind !== 'none') await this.spawnNext(updated, now);
    announce(updated);
    return dto(updated, actorId);
  },

  // POST /tasks/:id/reassign — the assigner hands open work to someone else.
  async reassign(actorId: string, id: string, input: { assignedTo: string; comment?: string | null }, now = new Date()): Promise<TaskDTO> {
    const { task } = await loadVisible(actorId, id);
    if (task.assignedBy !== actorId) throw Forbidden('Only the person who assigned this task can reassign it');
    if (!OPEN_STATUSES.includes(task.status)) throw BadRequest('Only open tasks can be reassigned');
    if (input.assignedTo === task.assignedTo) throw BadRequest('The task is already with that person');
    const people = await taskPeople.resolve([actorId, task.assignedTo, input.assignedTo]);
    const next = people.get(input.assignedTo);
    if (!next) throw BadRequest('Pick who the task is for');
    const self = input.assignedTo === actorId;
    const watchers = task.watchers.filter((w) => w.userId !== input.assignedTo);
    const updated = await taskRepo.update(id, {
      $set: {
        assignedTo: input.assignedTo,
        watchers,
        status: self ? 'accepted' : 'assigned',
        assignedAt: now,
        acceptedAt: self ? now : null,
        requestedDueAt: null,
        waitingOn: null,
        ...ALERTS_CLEARED,
        'alerts.acceptNudgeAt': null,
      },
    });
    if (!updated) throw NotFound('Task not found');
    if (updated.chatId) await chatService.setTaskChatMembers(updated.chatId, chatMembersOf(updated));
    const comment = input.comment?.trim() || null;
    await taskRepo.addHistory([
      { taskId: id, userId: actorId, field: 'assignedTo', oldValue: task.assignedTo, newValue: input.assignedTo, comment },
      { taskId: id, userId: actorId, field: 'status', oldValue: task.status, newValue: updated.status },
    ]);
    const actor = people.get(actorId) ?? unknownPerson(actorId);
    const old = people.get(task.assignedTo) ?? unknownPerson(task.assignedTo);
    await notice(updated, actorId, `${actor.name} reassigned this task from ${old.name} to ${next.name}${comment ? ` — ${comment}` : ''} · ${shortStamp(now, actor.tz)}`);
    await notify('reassigned', updated, [input.assignedTo], { actorId, comment });
    await notify('reassigned_away', updated, [task.assignedTo], { actorId, newAssigneeName: next.name });
    announce(updated, [task.assignedTo]);
    return dto(updated, actorId);
  },

  // PATCH /tasks/:id — the assigner edits; every change is logged and posted in the chat.
  async patch(actorId: string, id: string, input: PatchInput, now = new Date()): Promise<TaskDTO> {
    const { task } = await loadVisible(actorId, id);
    if (task.assignedBy !== actorId) throw Forbidden('Only the person who assigned this task can edit it');
    if (FINAL_STATUSES.includes(task.status)) throw BadRequest('This task is finished — reopen it before editing');
    const people = await taskPeople.resolve([actorId, task.assignedTo]);
    const actor = people.get(actorId) ?? unknownPerson(actorId);
    const assigneeTz = (people.get(task.assignedTo) ?? unknownPerson(task.assignedTo)).tz;
    const set: Record<string, unknown> = {};
    const rows: HistoryRow[] = [];
    const lines: string[] = [];
    const events: TaskEvent[] = [];
    const comment = input.comment?.trim() || null;

    if (input.title !== undefined) {
      const title = cleanTitle(input.title);
      if (title !== task.title) { set.title = title; rows.push({ taskId: id, userId: actorId, field: 'title', oldValue: task.title, newValue: title, comment }); lines.push(`renamed the task to "${title}"`); }
    }
    if (input.description !== undefined) {
      const description = cleanDescription(input.description);
      if (description !== task.description) { set.description = description; rows.push({ taskId: id, userId: actorId, field: 'description', oldValue: task.description, newValue: description, comment }); lines.push('edited the description'); }
    }
    if (input.priority !== undefined && input.priority !== task.priority) {
      set.priority = input.priority;
      rows.push({ taskId: id, userId: actorId, field: 'priority', oldValue: task.priority, newValue: input.priority, comment });
      lines.push(`changed the priority to ${input.priority === 'urgent' ? 'Urgent' : input.priority === 'high' ? 'High' : 'Normal'}`);
      events.push('priority_changed');
    }
    if (hasDue(input)) {
      const due = resolveDue(input, assigneeTz);
      if (!due) throw BadRequest('A due date is required');
      if (due.getTime() <= now.getTime()) throw BadRequest('The due date cannot be in the past');
      if (due.getTime() !== task.dueAt?.getTime()) {
        Object.assign(set, { dueAt: due, ...ALERTS_CLEARED });
        rows.push({ taskId: id, userId: actorId, field: 'dueAt', oldValue: isoOrNull(task.dueAt), newValue: due.toISOString(), comment });
        lines.push(`changed the due date to ${shortStamp(due, assigneeTz)}`);
        events.push('due_changed');
      }
    }
    if (input.branchId !== undefined && input.branchId !== task.branchId) {
      const companyId = await companyOfBranch(input.branchId);
      Object.assign(set, { branchId: input.branchId, companyId });
      rows.push({ taskId: id, userId: actorId, field: 'branchId', oldValue: task.branchId, newValue: input.branchId, comment });
      const { branches } = await branchNames([input.branchId]);
      lines.push(`moved the task to ${branches.get(input.branchId)?.name ?? 'another branch'}`);
    }
    if (input.department !== undefined && (input.department ?? null) !== (task.department ?? null)) {
      set.department = input.department ?? null;
      rows.push({ taskId: id, userId: actorId, field: 'department', oldValue: task.department ?? null, newValue: input.department ?? null, comment });
      lines.push(input.department ? `set the department to ${DEPARTMENT_LABEL[input.department]}` : 'cleared the department');
    }
    if (input.repeat !== undefined) {
      const repeat = cleanRepeat(input.repeat);
      if (!sameRepeat(repeat, task.repeat)) { set.repeat = repeat; rows.push({ taskId: id, userId: actorId, field: 'repeat', oldValue: JSON.stringify(task.repeat ?? { kind: 'none' }), newValue: JSON.stringify(repeat), comment }); lines.push(repeat.kind === 'none' ? 'stopped the repeat' : `set the task to repeat ${repeat.kind}`); }
    }
    if (input.link !== undefined && JSON.stringify(input.link) !== JSON.stringify(task.link ?? null)) {
      set.link = input.link;
      rows.push({ taskId: id, userId: actorId, field: 'link', oldValue: task.link ? JSON.stringify(task.link) : null, newValue: input.link ? JSON.stringify(input.link) : null, comment });
      lines.push(input.link ? `linked ${input.link.label}` : 'removed the link');
    }
    if (!rows.length) return dto(task, actorId);

    const updated = await taskRepo.update(id, { $set: set });
    if (!updated) throw NotFound('Task not found');
    await taskRepo.addHistory(rows);
    if (set.title && updated.chatId) await chatService.renameTaskChat(updated.chatId, updated.title);
    await notice(updated, actorId, `${actor.name} ${lines.join(', ')}${comment ? ` — ${comment}` : ''} · ${shortStamp(now, actor.tz)}`);
    for (const e of events) await notify(e, updated, [updated.assignedTo], { actorId, comment });
    announce(updated);
    return dto(updated, actorId);
  },

  // POST /tasks/:id/watchers — the assigner or assignee add/remove anyone; anyone who can see the
  // task can watch or stop watching it themselves. Watchers are the chat's other members.
  async watchers(actorId: string, id: string, input: { add?: string[]; remove?: string[] }, now = new Date()): Promise<TaskDTO> {
    const { task } = await loadVisible(actorId, id);
    const manager = task.assignedBy === actorId || task.assignedTo === actorId;
    const add = [...new Set(input.add ?? [])].filter((u) => u !== task.assignedBy && u !== task.assignedTo && !task.watchers.some((w) => w.userId === u));
    const remove = [...new Set(input.remove ?? [])].filter((u) => task.watchers.some((w) => w.userId === u));
    if (!manager && [...add, ...remove].some((u) => u !== actorId)) throw Forbidden('You can only watch or stop watching a task yourself');
    if (!add.length && !remove.length) return dto(task, actorId);
    const people = await taskPeople.resolve([actorId, ...add, ...remove]);
    const unknown = add.filter((u) => !people.has(u));
    if (unknown.length) throw BadRequest('One of the people picked does not exist');
    const watchers = [...task.watchers.filter((w) => !remove.includes(w.userId)), ...add.map((userId) => ({ userId, addedBy: actorId, addedAt: now }))];
    const updated = await taskRepo.update(id, { $set: { watchers } });
    if (!updated) throw NotFound('Task not found');
    if (updated.chatId) await chatService.setTaskChatMembers(updated.chatId, chatMembersOf(updated));
    const nameOf = (u: string): string => people.get(u)?.name ?? 'Someone';
    await taskRepo.addHistory([{
      taskId: id, userId: actorId, field: 'watchers',
      oldValue: task.watchers.map((w) => w.userId).join(',') || null,
      newValue: watchers.map((w) => w.userId).join(',') || null,
    }]);
    const actor = nameOf(actorId);
    const parts: string[] = [];
    if (add.length) parts.push(add.length === 1 && add[0] === actorId ? `${actor} is now watching this task` : `${actor} added ${add.map(nameOf).join(', ')} as watcher${add.length > 1 ? 's' : ''}`);
    if (remove.length) parts.push(remove.length === 1 && remove[0] === actorId ? `${actor} stopped watching this task` : `${actor} removed ${remove.map(nameOf).join(', ')} from the watchers`);
    await notice(updated, actorId, parts.join('; '));
    if (add.length) await notify('watcher_added', updated, add, { actorId });
    announce(updated, remove);
    return dto(updated, actorId);
  },

  // POST /tasks/:id/attachments — a file already uploaded via POST /api/uploads.
  async addAttachment(actorId: string, id: string, att: AttachmentInput, now = new Date()): Promise<TaskDTO> {
    const { task } = await loadVisible(actorId, id);
    if (!isParty(task, actorId)) throw Forbidden('Watch the task to add files to it');
    if (att.size > ATTACHMENT_MAX_BYTES) throw BadRequest(`"${att.name}" is over 20 MB`);
    const updated = await taskRepo.update(id, { $push: { attachments: { ...att, uploadedBy: actorId, uploadedAt: now } } });
    if (!updated) throw NotFound('Task not found');
    await taskRepo.addHistory([{ taskId: id, userId: actorId, field: 'attachment', newValue: att.name }]);
    const actor = (await taskPeople.one(actorId)) ?? unknownPerson(actorId);
    await notice(updated, actorId, `${actor.name} attached "${att.name}" to the task · ${shortStamp(now, actor.tz)}`);
    announce(updated);
    return dto(updated, actorId);
  },

  // POST /tasks/:id/chat — "Start chat" (owner, 2026-11-16 evening). No task comes with a chat: one of
  // the people on it — the person who gave it, the person it is for, or a watcher (owner, 2026-11-18:
  // "watcher can also") — starts one from inside the task, while the task is open. Everyone on the task
  // is a member. A manager above who only sees the task watches it first. An existing chat's id is
  // returned to anyone who may see the task.
  async ensureChat(actorId: string, id: string): Promise<{ chatId: string }> {
    const { task } = await loadVisible(actorId, id);
    if (task.chatId) return { chatId: task.chatId };
    if (!isParty(task, actorId)) throw Forbidden('Watch the task to start its chat');
    if (FINAL_STATUSES.includes(task.status)) throw BadRequest('This task is closed — reopen it to start a chat');
    const people = await taskPeople.resolve([actorId, task.assignedTo]);
    const to = people.get(task.assignedTo) ?? unknownPerson(task.assignedTo);
    const actor = people.get(actorId) ?? unknownPerson(actorId);
    const due = task.dueAt ? ` · due ${shortStamp(task.dueAt, to.tz)}` : '';
    const chatId = await chatService.createTaskChat(actorId, {
      taskId: id,
      title: task.title,
      memberIds: chatMembersOf(task),
      companyId: task.companyId,
      branchId: task.branchId,
      notice: `${actor.name} started a chat about this task · ${STATUS_LABEL[task.status]}${due}`,
    });
    // Two people opening it at the same moment: the first chat wins; the loser's empty chat is left unused.
    const updated = await taskRepo.update(id, { $set: { chatId } }, { chatId: null });
    if (!updated) return { chatId: (await taskRepo.byId(id))?.chatId ?? chatId };
    announce(updated);
    return { chatId };
  },

  // GET /tasks/:id/messages — read the task chat; a manager above the assignee may read without joining.
  async messages(actorId: string, id: string, page: { before?: string; after?: string; limit?: number }) {
    const { task } = await loadVisible(actorId, id);
    if (!task.chatId) return [];
    return chatService.readTaskMessages(task.chatId, actorId, page);
  },

  // GET /tasks/dashboard — the same scope as view=all, so every number matches its list.
  async dashboard(actorId: string, filter: { companyId?: string; branchId?: string } = {}, now = new Date()) {
    const me = (await taskPeople.one(actorId)) ?? unknownPerson(actorId);
    const today = localParts(now, me.tz).dayKey;
    const monthKey = today.slice(0, 7);
    const monthStart = zonedDateTime(`${monthKey}-01`, '00:00', me.tz);
    const live = await this.list(actorId, { view: 'all', state: 'open', companyId: filter.companyId, branchId: filter.branchId }, now);
    const closed = await this.list(actorId, { view: 'all', status: ['closed'], closedFrom: monthStart.toISOString(), companyId: filter.companyId, branchId: filter.branchId }, now);
    const scoped = [...live, ...closed];
    const isOpen = (t: TaskDTO): boolean => OPEN_STATUSES.includes(t.status);
    const dueToday = (t: TaskDTO): boolean => isOpen(t) && !!t.dueAt && localParts(new Date(t.dueAt), me.tz).dayKey === today;
    const closedThisMonth = (t: TaskDTO): boolean => t.status === 'closed' && !!t.closedAt && localParts(new Date(t.closedAt), me.tz).dayKey.slice(0, 7) === monthKey;
    const daysLate = (t: TaskDTO): number | null => {
      if (!t.dueAt) return null;
      const due = Date.parse(t.dueAt);
      const end = t.overdue ? now.getTime() : t.doneAt && closedThisMonth(t) ? Date.parse(t.doneAt) : null;
      if (end === null || end <= due) return t.overdue || closedThisMonth(t) ? 0 : null;
      return (end - due) / 86_400_000;
    };

    const byPerson = new Map<string, { userId: string; name: string; open: number; overdue: number; lateSum: number; lateN: number; closedThisMonth: number }>();
    const byBranch = new Map<string, { branchId: string; branchName: string | null; companyName: string | null; open: number; overdue: number }>();
    for (const t of scoped) {
      const p = byPerson.get(t.assignedTo.id) ?? { userId: t.assignedTo.id, name: t.assignedTo.name, open: 0, overdue: 0, lateSum: 0, lateN: 0, closedThisMonth: 0 };
      const b = byBranch.get(t.branchId) ?? { branchId: t.branchId, branchName: t.branchName, companyName: t.companyName, open: 0, overdue: 0 };
      if (isOpen(t)) { p.open += 1; b.open += 1; }
      if (t.overdue) { p.overdue += 1; b.overdue += 1; }
      if (closedThisMonth(t)) p.closedThisMonth += 1;
      const late = daysLate(t);
      if (late !== null) { p.lateSum += late; p.lateN += 1; }
      byPerson.set(p.userId, p);
      byBranch.set(b.branchId, b);
    }
    return {
      counts: {
        open: scoped.filter(isOpen).length,
        dueToday: scoped.filter(dueToday).length,
        overdue: scoped.filter((t) => t.overdue).length,
        waitingForMyCheck: scoped.filter((t) => t.status === 'done' && t.assignedBy.id === actorId).length,
      },
      byPerson: [...byPerson.values()]
        .filter((p) => p.open || p.overdue || p.closedThisMonth)
        .map(({ lateSum, lateN, ...p }) => ({ ...p, avgDaysLate: lateN ? Math.round((lateSum / lateN) * 10) / 10 : 0 }))
        .sort((a, b) => b.overdue - a.overdue || b.open - a.open || a.name.localeCompare(b.name)),
      byBranch: [...byBranch.values()].filter((b) => b.open || b.overdue).sort((a, b) => b.overdue - a.overdue || b.open - a.open),
    };
  },

  // GET /tasks/notifications — the in-app list.
  async notifications(actorId: string) {
    const rows = await taskRepo.notifications(actorId);
    return rows.map((r) => ({ id: String(r._id), taskId: r.taskId, event: r.event, title: r.title, body: r.body, sentAt: r.sentAt.toISOString(), opened: !!r.openedAt }));
  },
  markNotificationsOpened: (actorId: string, ids: string[] | null) => taskRepo.markNotificationsOpened(actorId, ids),

  // The next copy of a repeating task — once (claimed through nextSpawnedAt), when the current one is
  // closed or the next date arrives while it is still open. A cancelled task ends its series.
  async spawnNext(task: TaskDoc, now = new Date()): Promise<string | null> {
    if (!task.repeat || task.repeat.kind === 'none' || !task.dueAt || task.status === 'cancelled') return null;
    const claimed = await taskRepo.update(String(task._id), { $set: { nextSpawnedAt: now } }, { nextSpawnedAt: null });
    if (!claimed) return null;
    const assignee = (await taskPeople.one(task.assignedTo)) ?? unknownPerson(task.assignedTo);
    let next = nextOccurrence(task.dueAt, task.repeat, assignee.tz);
    for (let i = 0; next && next.getTime() <= now.getTime() && i < 400; i += 1) next = nextOccurrence(next, task.repeat, assignee.tz);
    if (!next) return null;
    const created = await this.create(task.assignedBy, {
      title: task.title,
      description: task.description,
      assignedTo: task.assignedTo,
      watcherIds: task.watchers.map((w) => w.userId),
      branchId: task.branchId,
      companyId: task.companyId,
      priority: task.priority,
      department: task.department ?? null,
      dueAt: next.toISOString(),
      repeat: task.repeat,
      link: task.link,
      source: task.source === 'erp' ? 'erp' : 'app',
    }, { now, parentRecurringId: task.parentRecurringId ?? String(task._id), allowPast: true });
    return created.id;
  },

  // Used by the sweep: overdue-ness without a DTO.
  isOverdue,
};
