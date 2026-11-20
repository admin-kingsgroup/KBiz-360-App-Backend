import { mailer } from '../../mailer';
import { TaskDigestModel, TaskModel, type TaskDoc } from './task.model';
import { taskNotify, type TaskEvent } from './task.notify';
import { taskPeople, unknownPerson, type TaskPerson } from './task.people';
import { taskPush } from './task.push';
import { tasksService } from './task.service';
import { addDays, DEFAULT_TZ, localParts, nextOccurrence, shortStamp, tzForBranchCode, workingMsBetween } from './task.time';
import { OPEN_STATUSES } from './task.types';

// The task clock (spec §6/§8, minus escalation — owner 2026-11-16). Runs every minute; each one-shot
// alert is CLAIMED with an atomic update on its own null stamp, so a slow tick, a restart or a second
// process can never send it twice. A due-date change re-arms the stamps (service).
const H = 3_600_000;
export const ACCEPT_NUDGE_MS = 4 * H; // "not accepted after 4 working hours"
const DUE_TOMORROW_FROM_HOUR = 9; // the "due tomorrow" alert goes out from 9 am the day before
const DIGEST_HOUR = 8; // daily digest email at 8 am local

type AlertKey = 'dueTomorrowAt' | 'due2hAt' | 'overdueAt' | 'acceptNudgeAt';

async function claim(task: TaskDoc, key: AlertKey, now: Date, alsoStamp: AlertKey[] = []): Promise<TaskDoc | null> {
  const set: Record<string, Date> = { [`alerts.${key}`]: now };
  for (const k of alsoStamp) set[`alerts.${k}`] = now;
  return TaskModel().findOneAndUpdate({ _id: task._id, [`alerts.${key}`]: null }, { $set: set }, { returnDocument: 'after' }).lean<TaskDoc>();
}

async function fire(event: TaskEvent, task: TaskDoc, key: AlertKey, recipients: string[], now: Date, alsoStamp: AlertKey[] = []): Promise<boolean> {
  const claimed = await claim(task, key, now, alsoStamp);
  if (!claimed) return false;
  await taskNotify.send(event, claimed, recipients, { actorId: null });
  return true;
}

export interface SweepResult { dueTomorrow: number; due2h: number; overdue: number; acceptNudge: number; spawned: number; digests: number; receipts: number }

export async function runTaskSweep(now = new Date()): Promise<SweepResult> {
  const out: SweepResult = { dueTomorrow: 0, due2h: 0, overdue: 0, acceptNudge: 0, spawned: 0, digests: 0, receipts: 0 };
  const open = { $in: OPEN_STATUSES };
  const people = new Map<string, TaskPerson>();
  const tzOf = async (id: string): Promise<string> => {
    if (!people.has(id)) people.set(id, (await taskPeople.one(id)) ?? unknownPerson(id));
    return (people.get(id) as TaskPerson).tz;
  };

  // Overdue at the due time → assignee and assigner.
  for (const t of await TaskModel().find({ status: open, dueAt: { $ne: null, $lte: now }, 'alerts.overdueAt': null }).lean<TaskDoc[]>()) {
    if (await fire('overdue', t, 'overdueAt', [t.assignedTo, t.assignedBy], now, ['due2hAt', 'dueTomorrowAt'])) out.overdue += 1;
  }
  // Due in 2 hours → assignee (Urgent: through quiet hours, time-sensitive — taskNotify).
  for (const t of await TaskModel().find({
    status: open, dueAt: { $gt: now, $lte: new Date(now.getTime() + 2 * H) }, 'alerts.due2hAt': null, createdAt: { $lte: new Date(now.getTime() - 30 * 60_000) },
  }).lean<TaskDoc[]>()) {
    if (await fire('due_2h', t, 'due2hAt', [t.assignedTo], now, ['dueTomorrowAt'])) out.due2h += 1;
  }
  // Due tomorrow → assignee, from 9 am (their time) on the day before the due day.
  for (const t of await TaskModel().find({
    status: open, dueAt: { $gt: new Date(now.getTime() + 2 * H), $lte: new Date(now.getTime() + 48 * H) }, 'alerts.dueTomorrowAt': null, createdAt: { $lte: new Date(now.getTime() - H) },
  }).lean<TaskDoc[]>()) {
    const tz = await tzOf(t.assignedTo);
    const here = localParts(now, tz);
    if (here.hour < DUE_TOMORROW_FROM_HOUR) continue;
    if (localParts(t.dueAt as Date, tz).dayKey !== addDays(here.dayKey, 1)) continue;
    if (await fire('due_tomorrow', t, 'dueTomorrowAt', [t.assignedTo], now)) out.dueTomorrow += 1;
  }
  // Not accepted after 4 working hours → the assignee, once.
  for (const t of await TaskModel().find({ status: 'assigned', 'alerts.acceptNudgeAt': null, assignedAt: { $lte: new Date(now.getTime() - ACCEPT_NUDGE_MS) } }).lean<TaskDoc[]>()) {
    if (workingMsBetween(new Date(t.assignedAt), now, await tzOf(t.assignedTo)) < ACCEPT_NUDGE_MS) continue;
    if (await fire('accept_nudge', t, 'acceptNudgeAt', [t.assignedTo], now)) out.acceptNudge += 1;
  }
  // Repeating tasks: the next copy when this one is closed (catch-up — closing spawns it at once), or
  // when the next date's day begins while this one is still open.
  for (const t of await TaskModel().find({
    'repeat.kind': { $in: ['daily', 'weekly', 'monthly'] }, nextSpawnedAt: null, status: { $ne: 'cancelled' }, dueAt: { $ne: null },
  }).lean<TaskDoc[]>()) {
    let due = t.status === 'closed';
    if (!due) {
      const tz = await tzOf(t.assignedTo);
      const next = nextOccurrence(t.dueAt as Date, t.repeat, tz);
      due = !!next && localParts(now, tz).dayKey >= localParts(next, tz).dayKey;
    }
    if (due && await tasksService.spawnNext(t, now)) out.spawned += 1;
  }
  // The digest only runs while it is 8 am somewhere we have people (saves a full scan every minute).
  const zones = [DEFAULT_TZ, tzForBranchCode('NBO'), tzForBranchCode('FBM')];
  if (zones.some((z) => localParts(now, z).hour === DIGEST_HOUR)) out.digests = await sendDigests(now);
  // Did the task pushes of 15+ minutes ago reach the phones? Expo's receipts say (task.push.ts). Never fails the sweep.
  out.receipts = await taskPush.checkReceipts(now).catch(() => 0);
  return out;
}

// 8 am digest email: my open, due-today and overdue tasks; for an assigner, also the tasks they gave
// that are overdue. One per person per local day (claimed in task_digests).
export async function sendDigests(now = new Date()): Promise<number> {
  const live = await TaskModel().find({ status: { $in: [...OPEN_STATUSES, 'done'] } }).lean<TaskDoc[]>();
  const userIds = [...new Set(live.flatMap((t) => [t.assignedTo, t.assignedBy]))];
  if (!userIds.length) return 0;
  const people = await taskPeople.resolve(userIds);
  let sent = 0;
  for (const uid of userIds) {
    const p = people.get(uid);
    if (!p?.email) continue;
    const here = localParts(now, p.tz);
    if (here.hour !== DIGEST_HOUR) continue;
    const mine = live.filter((t) => t.assignedTo === uid && OPEN_STATUSES.includes(t.status));
    const overdue = mine.filter((t) => t.dueAt && t.dueAt.getTime() < now.getTime());
    const today = mine.filter((t) => t.dueAt && t.dueAt.getTime() >= now.getTime() && localParts(t.dueAt, p.tz).dayKey === here.dayKey);
    const gaveOverdue = live.filter((t) => t.assignedBy === uid && t.assignedTo !== uid && OPEN_STATUSES.includes(t.status) && t.dueAt && t.dueAt.getTime() < now.getTime());
    const toCheck = live.filter((t) => t.assignedBy === uid && t.status === 'done');
    if (!mine.length && !gaveOverdue.length && !toCheck.length) continue;
    try {
      await TaskDigestModel().create({ userId: uid, dayKey: here.dayKey, sentAt: now });
    } catch {
      continue; // already sent today (unique userId + dayKey)
    }
    const line = (t: TaskDoc): string => `• ${t.title}${t.dueAt ? ` — due ${shortStamp(t.dueAt, p.tz)}` : ''}`;
    const assigneeNames = await taskPeople.resolve(gaveOverdue.map((t) => t.assignedTo));
    const sections: string[] = [];
    if (overdue.length) sections.push(`Overdue (${overdue.length})\n${overdue.map(line).join('\n')}`);
    if (today.length) sections.push(`Due today (${today.length})\n${today.map(line).join('\n')}`);
    sections.push(`All my open tasks: ${mine.length}`);
    if (toCheck.length) sections.push(`Waiting for your check (${toCheck.length})\n${toCheck.map(line).join('\n')}`);
    if (gaveOverdue.length) sections.push(`Tasks you gave that are overdue (${gaveOverdue.length})\n${gaveOverdue.map((t) => `${line(t)} · ${assigneeNames.get(t.assignedTo)?.name ?? ''}`).join('\n')}`);
    const ok = await mailer.send({
      to: p.email,
      subject: `Your tasks today — ${overdue.length} overdue, ${today.length} due today`,
      text: `Good morning ${p.name.split(' ')[0]},\n\n${sections.join('\n\n')}\n\nOpen KBiz360 Smart Connect → Tasks for details.`,
    });
    if (ok) sent += 1;
  }
  return sent;
}

let timer: ReturnType<typeof setInterval> | null = null;
let running = false;
export function startTaskSweep(intervalMs = 60_000): void {
  if (timer) return;
  timer = setInterval(() => {
    if (running) return; // never overlap two ticks
    running = true;
    void runTaskSweep()
      .catch((e: Error) => {
        // eslint-disable-next-line no-console
        console.warn('[task-sweep] error:', e.message);
      })
      .finally(() => { running = false; });
  }, intervalMs);
}
export function stopTaskSweep(): void {
  if (timer) { clearInterval(timer); timer = null; }
}
