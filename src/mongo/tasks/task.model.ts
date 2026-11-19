import { Schema, type Model, type Types } from 'mongoose';
import { appDb } from '../connection';
import { TASK_DEPARTMENTS, TASK_PRIORITIES, TASK_STATUSES, type RepeatRule, type TaskDepartment, type TaskPriority, type TaskStatus } from './task.types';

// ─────────── tasks ───────────
export interface TaskWatcher { userId: string; addedBy: string; addedAt: Date }
export interface TaskAttachment { url: string; name: string; size: number; mime: string; uploadedBy: string; uploadedAt: Date }
export interface TaskAlerts {
  dueTomorrowAt: Date | null;
  due2hAt: Date | null;
  overdueAt: Date | null;
  acceptNudgeAt: Date | null;
}
export interface TaskDoc {
  _id: Types.ObjectId;
  title: string;
  description: string;
  companyId: string | null;
  branchId: string;
  assignedTo: string; // CRM user _id
  assignedBy: string; // CRM user _id (the creator)
  watchers: TaskWatcher[];
  priority: TaskPriority;
  department: TaskDepartment | null; // Operations / Accounts — which branch group the task was shared in
  dueAt: Date | null; // required on create; null only on tasks converted from undated reminders
  status: TaskStatus;
  requestedDueAt: Date | null; // the date the assignee asked for (Date change requested)
  waitingOn: string | null; // who or what the assignee is waiting on
  attachments: TaskAttachment[];
  repeat: RepeatRule;
  parentRecurringId: string | null; // the first task of a repeating series
  nextSpawnedAt: Date | null; // when the next copy of a repeating task was created (claims it once)
  chatId: string | null; // the task's conversation
  link: { label: string; url: string } | null; // ERP voucher / booking this task is about
  source: 'app' | 'erp' | 'reminder';
  legacyReminderId: string | null; // the reminder this task was converted from
  assignedAt: Date; // last (re)assignment — drives the 4-working-hour acceptance nudge
  acceptedAt: Date | null;
  doneAt: Date | null;
  closedAt: Date | null;
  cancelledAt: Date | null;
  alerts: TaskAlerts; // when each one-shot alert was sent (null = not yet); re-armed on a due-date change
  createdAt: Date;
  updatedAt: Date;
}

const TaskSchema = new Schema<TaskDoc>(
  {
    title: { type: String, required: true },
    description: { type: String, default: '' },
    companyId: { type: String, default: null },
    branchId: { type: String, required: true },
    assignedTo: { type: String, required: true },
    assignedBy: { type: String, required: true },
    watchers: { type: [new Schema<TaskWatcher>({ userId: String, addedBy: String, addedAt: Date }, { _id: false })], default: [] },
    priority: { type: String, enum: TASK_PRIORITIES, default: 'normal' },
    department: { type: String, enum: [...TASK_DEPARTMENTS, null], default: null },
    dueAt: { type: Date, default: null },
    status: { type: String, enum: TASK_STATUSES, default: 'assigned' },
    requestedDueAt: { type: Date, default: null },
    waitingOn: { type: String, default: null },
    attachments: {
      type: [new Schema<TaskAttachment>({ url: String, name: String, size: Number, mime: String, uploadedBy: String, uploadedAt: Date }, { _id: false })],
      default: [],
    },
    repeat: { type: Schema.Types.Mixed, default: () => ({ kind: 'none' }) },
    parentRecurringId: { type: String, default: null },
    nextSpawnedAt: { type: Date, default: null },
    chatId: { type: String, default: null },
    link: { type: new Schema({ label: String, url: String }, { _id: false }), default: null },
    source: { type: String, enum: ['app', 'erp', 'reminder'], default: 'app' },
    legacyReminderId: { type: String, default: null },
    assignedAt: { type: Date, default: Date.now },
    acceptedAt: { type: Date, default: null },
    doneAt: { type: Date, default: null },
    closedAt: { type: Date, default: null },
    cancelledAt: { type: Date, default: null },
    alerts: {
      type: new Schema<TaskAlerts>(
        { dueTomorrowAt: { type: Date, default: null }, due2hAt: { type: Date, default: null }, overdueAt: { type: Date, default: null }, acceptNudgeAt: { type: Date, default: null } },
        { _id: false },
      ),
      default: () => ({ dueTomorrowAt: null, due2hAt: null, overdueAt: null, acceptNudgeAt: null }),
    },
  },
  { timestamps: true, collection: 'tasks' },
);
TaskSchema.index({ assignedTo: 1, status: 1, dueAt: 1 });
TaskSchema.index({ assignedBy: 1, status: 1, dueAt: 1 });
TaskSchema.index({ 'watchers.userId': 1, status: 1 });
TaskSchema.index({ status: 1, dueAt: 1 }); // sweep + dashboard
TaskSchema.index({ chatId: 1 });
TaskSchema.index({ legacyReminderId: 1 }, { sparse: true });
TaskSchema.index({ parentRecurringId: 1 });

let _Task: Model<TaskDoc> | null = null;
export function TaskModel(): Model<TaskDoc> {
  if (!_Task) _Task = appDb().model<TaskDoc>('Task', TaskSchema);
  return _Task;
}

// ─────────── task_history (audit: nothing is ever deleted) ───────────
export type HistoryField =
  | 'created' | 'status' | 'title' | 'description' | 'dueAt' | 'priority' | 'branchId'
  | 'assignedTo' | 'watchers' | 'attachment' | 'repeat' | 'link' | 'department';
export interface TaskHistoryDoc {
  _id: Types.ObjectId;
  taskId: string;
  userId: string;
  field: HistoryField;
  oldValue: string | null;
  newValue: string | null;
  comment: string | null;
  createdAt: Date;
}
const TaskHistorySchema = new Schema<TaskHistoryDoc>(
  {
    taskId: { type: String, required: true },
    userId: { type: String, required: true },
    field: { type: String, required: true },
    oldValue: { type: String, default: null },
    newValue: { type: String, default: null },
    comment: { type: String, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false }, collection: 'task_history' },
);
TaskHistorySchema.index({ taskId: 1, createdAt: 1 });

let _TaskHistory: Model<TaskHistoryDoc> | null = null;
export function TaskHistoryModel(): Model<TaskHistoryDoc> {
  if (!_TaskHistory) _TaskHistory = appDb().model<TaskHistoryDoc>('TaskHistory', TaskHistorySchema);
  return _TaskHistory;
}

// ─────────── task_notifications (spec's notification_log + the in-app list) ───────────
export interface TaskNotificationDoc {
  _id: Types.ObjectId;
  userId: string;
  taskId: string;
  event: string;
  title: string;
  body: string;
  channels: Array<'push' | 'email' | 'inapp'>;
  sentAt: Date;
  openedAt: Date | null;
}
const TaskNotificationSchema = new Schema<TaskNotificationDoc>(
  {
    userId: { type: String, required: true },
    taskId: { type: String, required: true },
    event: { type: String, required: true },
    title: { type: String, default: '' },
    body: { type: String, default: '' },
    channels: { type: [String], default: [] },
    sentAt: { type: Date, default: Date.now },
    openedAt: { type: Date, default: null },
  },
  { collection: 'task_notifications' },
);
TaskNotificationSchema.index({ userId: 1, sentAt: -1 });
TaskNotificationSchema.index({ sentAt: 1 }, { expireAfterSeconds: 180 * 86_400 }); // keep 6 months

let _TaskNotification: Model<TaskNotificationDoc> | null = null;
export function TaskNotificationModel(): Model<TaskNotificationDoc> {
  if (!_TaskNotification) _TaskNotification = appDb().model<TaskNotificationDoc>('TaskNotification', TaskNotificationSchema);
  return _TaskNotification;
}

// ─────────── task_digests (one 8 am digest per user per local day) ───────────
export interface TaskDigestDoc { _id: Types.ObjectId; userId: string; dayKey: string; sentAt: Date }
const TaskDigestSchema = new Schema<TaskDigestDoc>(
  { userId: { type: String, required: true }, dayKey: { type: String, required: true }, sentAt: { type: Date, default: Date.now } },
  { collection: 'task_digests' },
);
TaskDigestSchema.index({ userId: 1, dayKey: 1 }, { unique: true });
TaskDigestSchema.index({ sentAt: 1 }, { expireAfterSeconds: 30 * 86_400 });

let _TaskDigest: Model<TaskDigestDoc> | null = null;
export function TaskDigestModel(): Model<TaskDigestDoc> {
  if (!_TaskDigest) _TaskDigest = appDb().model<TaskDigestDoc>('TaskDigest', TaskDigestSchema);
  return _TaskDigest;
}

export async function ensureTaskIndexes(): Promise<void> {
  await TaskModel().createIndexes();
  await TaskHistoryModel().createIndexes();
  await TaskNotificationModel().createIndexes();
  await TaskDigestModel().createIndexes();
}
