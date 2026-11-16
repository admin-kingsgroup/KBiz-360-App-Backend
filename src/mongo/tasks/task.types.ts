// Smart Connect Tasks (Afshin's spec 2026-11-16, with the owner's answers the same day): tasks replace
// reminders. One assignee per task, watchers optional, a chat per task that never locks.

export type TaskStatus =
  | 'assigned' // created, not yet accepted
  | 'date_change_requested' // assignee asked for a new due date (reason + date)
  | 'accepted'
  | 'in_progress'
  | 'waiting' // "Waiting on someone" — assignee names who or what
  | 'done' // "Done – to close": the assigner still checks it
  | 'closed' // the assigner is satisfied
  | 'reopened' // the assigner sent it back
  | 'cancelled'; // no longer needed (final)

export const TASK_STATUSES: TaskStatus[] = [
  'assigned', 'date_change_requested', 'accepted', 'in_progress', 'waiting', 'done', 'closed', 'reopened', 'cancelled',
];

// Work still to be done by the assignee. `done` is NOT open (the work is finished, the assigner checks
// it) and is therefore never overdue; it is still shown in the open lists as "Done – waiting to close".
export const OPEN_STATUSES: TaskStatus[] = ['assigned', 'date_change_requested', 'accepted', 'in_progress', 'waiting', 'reopened'];
// Statuses listed under the "open" lists (the assignee's work plus the assigner's check).
export const LIVE_STATUSES: TaskStatus[] = [...OPEN_STATUSES, 'done'];
export const FINAL_STATUSES: TaskStatus[] = ['closed', 'cancelled'];

export type TaskPriority = 'urgent' | 'high' | 'normal';
export const TASK_PRIORITIES: TaskPriority[] = ['urgent', 'high', 'normal'];

export type RepeatRule =
  | { kind: 'none' }
  | { kind: 'daily' }
  | { kind: 'weekly'; days: number[] } // 0 = Sunday … 6 = Saturday
  | { kind: 'monthly'; dayOfMonth: number }; // 1–31; clamps to the month's last day

// The status a comment is compulsory for (spec §4 Rules).
export const COMMENT_REQUIRED: TaskStatus[] = ['date_change_requested', 'waiting', 'reopened', 'cancelled'];

export const STATUS_LABEL: Record<TaskStatus, string> = {
  assigned: 'Assigned',
  date_change_requested: 'Date change requested',
  accepted: 'Accepted',
  in_progress: 'In progress',
  waiting: 'Waiting on someone',
  done: 'Done – to close',
  closed: 'Closed',
  reopened: 'Reopened',
  cancelled: 'Cancelled',
};

export const TITLE_MAX = 120;
export const DESCRIPTION_MAX = 2000;
export const DEFAULT_DUE_TIME = '18:00'; // 6 pm in the assignee's time zone
