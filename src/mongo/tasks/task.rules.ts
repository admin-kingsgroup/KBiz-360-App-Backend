import { BadRequest, Forbidden } from '../../common/errors';
import { COMMENT_REQUIRED, OPEN_STATUSES, STATUS_LABEL, type TaskStatus } from './task.types';

// The task status machine (spec §4). Pure: no I/O, enforced on the server for every client.
// "A" = the assignee moves the work forward; "B" = the person who assigned it closes, reopens,
// cancels and answers a date-change request. A task someone sets for themselves is both.
type Who = 'A' | 'B';
const ROWS: Array<[TaskStatus, TaskStatus, Who]> = [
  ['assigned', 'accepted', 'A'],
  ['assigned', 'date_change_requested', 'A'],
  ['date_change_requested', 'accepted', 'B'],
  ['accepted', 'in_progress', 'A'],
  ['in_progress', 'waiting', 'A'],
  ['in_progress', 'done', 'A'],
  ['waiting', 'in_progress', 'A'],
  ['waiting', 'done', 'A'],
  ['reopened', 'in_progress', 'A'],
  ['done', 'closed', 'B'],
  ['done', 'reopened', 'B'],
  ['closed', 'reopened', 'B'],
  ...OPEN_STATUSES.map((s): [TaskStatus, TaskStatus, Who] => [s, 'cancelled', 'B']),
];
// A personal to-do can be ticked off straight from Accepted / Reopened (no "In progress" step needed).
const SELF_ROWS: Array<[TaskStatus, TaskStatus]> = [
  ['accepted', 'done'],
  ['reopened', 'done'],
];

export interface RuleTask {
  status: TaskStatus;
  assignedBy: string;
  assignedTo: string;
  dueAt?: Date | null;
  requestedDueAt?: Date | null;
}

export const isSelfTask = (t: Pick<RuleTask, 'assignedBy' | 'assignedTo'>): boolean => t.assignedBy === t.assignedTo;

// Overdue is a flag, not a status: open work whose due time has passed. A task without a due date
// (only converted reminders can lack one) is never overdue.
export function isOverdue(t: { status: TaskStatus; dueAt: Date | null }, now: Date): boolean {
  return OPEN_STATUSES.includes(t.status) && !!t.dueAt && t.dueAt.getTime() < now.getTime();
}

export function allowedTransitions(t: RuleTask, actorId: string): TaskStatus[] {
  const isA = actorId === t.assignedTo;
  const isB = actorId === t.assignedBy;
  if (!isA && !isB) return [];
  const out = new Set<TaskStatus>();
  for (const [from, to, who] of ROWS) {
    if (from !== t.status) continue;
    if ((who === 'A' && isA) || (who === 'B' && isB)) out.add(to);
  }
  if (isA && isB) {
    for (const [from, to] of SELF_ROWS) if (from === t.status) out.add(to);
    out.delete('date_change_requested'); // asking yourself for a new date: just edit the date
  }
  return [...out];
}

export const ALERTS_CLEARED = {
  'alerts.dueTomorrowAt': null,
  'alerts.due2hAt': null,
  'alerts.overdueAt': null,
};

export interface TransitionInput { comment?: string | null; dueAt?: Date | null }
export interface TransitionPlan { status: TaskStatus; set: Record<string, unknown> }

// Validate a status change and say exactly what to write. Throws BadRequest for an impossible move
// or missing input, Forbidden when the move exists but belongs to the other party.
export function planTransition(t: RuleTask, actorId: string, to: TaskStatus, input: TransitionInput, now: Date): TransitionPlan {
  const reachable = ROWS.some(([from, target]) => from === t.status && target === to)
    || (isSelfTask(t) && SELF_ROWS.some(([from, target]) => from === t.status && target === to));
  if (!reachable) throw BadRequest(`A task that is "${STATUS_LABEL[t.status]}" cannot move to "${STATUS_LABEL[to]}"`);
  if (!allowedTransitions(t, actorId).includes(to)) {
    const owner = ROWS.find(([from, target]) => from === t.status && target === to)?.[2];
    throw Forbidden(owner === 'B' ? 'Only the person who assigned this task can do that' : 'Only the person the task is assigned to can do that');
  }
  const comment = input.comment?.trim() || null;
  if (COMMENT_REQUIRED.includes(to) && !comment) {
    throw BadRequest(to === 'waiting' ? 'Say who or what you are waiting on' : 'A reason is required');
  }

  const set: Record<string, unknown> = { status: to };
  let status: TaskStatus = to;
  switch (to) {
    case 'date_change_requested': {
      if (!input.dueAt) throw BadRequest('Pick the new due date you are asking for');
      if (input.dueAt.getTime() <= now.getTime()) throw BadRequest('The new due date cannot be in the past');
      set.requestedDueAt = input.dueAt;
      break;
    }
    case 'accepted': {
      set.acceptedAt = now;
      if (t.status === 'date_change_requested') {
        const due = input.dueAt ?? t.requestedDueAt ?? null;
        if (!due) throw BadRequest('Pick the due date');
        if (due.getTime() <= now.getTime()) throw BadRequest('The due date cannot be in the past');
        set.dueAt = due;
        set.requestedDueAt = null;
        Object.assign(set, ALERTS_CLEARED);
      }
      break;
    }
    case 'waiting':
      set.waitingOn = comment;
      break;
    case 'in_progress':
      set.waitingOn = null;
      break;
    case 'done':
      set.doneAt = now;
      set.waitingOn = null;
      if (isSelfTask(t)) { status = 'closed'; set.status = 'closed'; set.closedAt = now; } // Done closes your own to-do
      break;
    case 'closed':
      set.closedAt = now;
      break;
    case 'reopened':
      set.doneAt = null;
      set.closedAt = null;
      break;
    case 'cancelled':
      set.cancelledAt = now;
      break;
    default:
      break;
  }
  return { status, set };
}
