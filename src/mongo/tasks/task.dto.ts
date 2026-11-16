import { Types } from 'mongoose';
import { crmRepo } from '../crm.repo';
import { chatService } from '../chat/chat.service';
import type { TaskDoc, TaskHistoryDoc } from './task.model';
import { taskPeople, type TaskPerson } from './task.people';
import { allowedTransitions, isOverdue } from './task.rules';
import { FINAL_STATUSES, OPEN_STATUSES, type RepeatRule, type TaskPriority, type TaskStatus } from './task.types';

// The task as the app sees it (plan Task 3 — the keys are the app's contract).
export interface PersonRef { id: string; name: string }
export type TaskRole = 'assigner' | 'assignee' | 'both' | 'watcher' | 'viewer';
export interface TaskDTO {
  id: string;
  title: string;
  description: string;
  companyId: string | null;
  companyName: string | null;
  branchId: string;
  branchName: string | null;
  assignedTo: PersonRef;
  assignedBy: PersonRef;
  watchers: PersonRef[];
  priority: TaskPriority;
  dueAt: string | null;
  status: TaskStatus;
  requestedDueAt: string | null;
  waitingOn: string | null;
  attachments: Array<{ url: string; name: string; size: number; mime: string; uploadedBy: string; uploadedAt: string }>;
  repeat: RepeatRule;
  link: { label: string; url: string } | null;
  chatId: string | null;
  unread: number;
  overdue: boolean;
  isSelf: boolean;
  myRole: TaskRole;
  actions: TaskStatus[];
  canEdit: boolean;
  canReassign: boolean;
  source: TaskDoc['source'];
  createdAt: string;
  acceptedAt: string | null;
  doneAt: string | null;
  closedAt: string | null;
  cancelledAt: string | null;
}
export interface HistoryDTO {
  id: string;
  userId: string;
  userName: string;
  field: TaskHistoryDoc['field'];
  oldValue: string | null;
  newValue: string | null;
  comment: string | null;
  at: string;
}

const iso = (d: Date | null | undefined): string | null => (d ? new Date(d).toISOString() : null);

export function roleOf(t: Pick<TaskDoc, 'assignedBy' | 'assignedTo' | 'watchers'>, viewerId: string): TaskRole {
  const a = t.assignedTo === viewerId;
  const b = t.assignedBy === viewerId;
  if (a && b) return 'both';
  if (b) return 'assigner';
  if (a) return 'assignee';
  if (t.watchers.some((w) => w.userId === viewerId)) return 'watcher';
  return 'viewer';
}

export async function branchNames(ids: string[]): Promise<{ branches: Map<string, { name: string; companyId: string | null }>; companies: Map<string, string> }> {
  const oids = [...new Set(ids)].filter((id) => Types.ObjectId.isValid(id)).map((id) => new Types.ObjectId(id));
  const rows = oids.length ? await crmRepo.branchesByIds(oids) : [];
  const branches = new Map(rows.map((b) => [String(b._id), { name: b.name ?? b.code ?? 'Branch', companyId: b.company_id ? String(b.company_id) : null }]));
  const companyIds = [...new Set(rows.map((b) => (b.company_id ? String(b.company_id) : '')).filter(Boolean))];
  const companyRows = companyIds.length ? await crmRepo.listCompanies({ _id: { $in: companyIds.map((c) => new Types.ObjectId(c)) } }) : [];
  return { branches, companies: new Map(companyRows.map((c) => [String(c._id), c.name])) };
}

export async function toTaskDTOs(tasks: TaskDoc[], viewerId: string, now = new Date()): Promise<TaskDTO[]> {
  if (!tasks.length) return [];
  const people = await taskPeople.resolve(tasks.flatMap((t) => [t.assignedTo, t.assignedBy, ...t.watchers.map((w) => w.userId)]));
  const { branches, companies } = await branchNames(tasks.map((t) => t.branchId));
  const unread = await chatService.unreadFor(tasks.map((t) => t.chatId).filter((c): c is string => !!c), viewerId);
  const ref = (id: string): PersonRef => ({ id, name: (people.get(id) as TaskPerson | undefined)?.name ?? 'Unknown' });
  return tasks.map((t) => {
    const companyId = t.companyId ?? branches.get(t.branchId)?.companyId ?? null;
    const isAssigner = t.assignedBy === viewerId;
    return {
      id: String(t._id),
      title: t.title,
      description: t.description ?? '',
      companyId,
      companyName: companyId ? companies.get(companyId) ?? null : null,
      branchId: t.branchId,
      branchName: branches.get(t.branchId)?.name ?? null,
      assignedTo: ref(t.assignedTo),
      assignedBy: ref(t.assignedBy),
      watchers: t.watchers.map((w) => ref(w.userId)),
      priority: t.priority,
      dueAt: iso(t.dueAt),
      status: t.status,
      requestedDueAt: iso(t.requestedDueAt),
      waitingOn: t.waitingOn ?? null,
      attachments: (t.attachments ?? []).map((a) => ({ url: a.url, name: a.name, size: a.size, mime: a.mime, uploadedBy: a.uploadedBy, uploadedAt: iso(a.uploadedAt) ?? '' })),
      repeat: t.repeat ?? { kind: 'none' },
      link: t.link ?? null,
      chatId: t.chatId ?? null,
      unread: t.chatId ? unread[t.chatId] ?? 0 : 0,
      overdue: isOverdue(t, now),
      isSelf: t.assignedBy === t.assignedTo,
      myRole: roleOf(t, viewerId),
      actions: allowedTransitions(t, viewerId),
      canEdit: isAssigner && !FINAL_STATUSES.includes(t.status),
      canReassign: isAssigner && OPEN_STATUSES.includes(t.status),
      source: t.source ?? 'app',
      createdAt: iso(t.createdAt) ?? '',
      acceptedAt: iso(t.acceptedAt),
      doneAt: iso(t.doneAt),
      closedAt: iso(t.closedAt),
      cancelledAt: iso(t.cancelledAt),
    };
  });
}

export async function toHistoryDTOs(rows: TaskHistoryDoc[]): Promise<HistoryDTO[]> {
  const people = await taskPeople.resolve(rows.map((r) => r.userId));
  return rows.map((r) => ({
    id: String(r._id),
    userId: r.userId,
    userName: people.get(r.userId)?.name ?? 'Unknown',
    field: r.field,
    oldValue: r.oldValue ?? null,
    newValue: r.newValue ?? null,
    comment: r.comment ?? null,
    at: iso(r.createdAt) ?? '',
  }));
}
