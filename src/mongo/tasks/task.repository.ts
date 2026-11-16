import { Types } from 'mongoose';
import { TaskHistoryModel, TaskModel, TaskNotificationModel, type HistoryField, type TaskDoc, type TaskHistoryDoc, type TaskNotificationDoc } from './task.model';

const oid = (id: string): Types.ObjectId | null => (Types.ObjectId.isValid(id) ? new Types.ObjectId(id) : null);

export interface HistoryRow {
  taskId: string;
  userId: string;
  field: HistoryField;
  oldValue?: string | null;
  newValue?: string | null;
  comment?: string | null;
}

export const taskRepo = {
  async create(doc: Partial<TaskDoc>): Promise<TaskDoc> {
    const created = await TaskModel().create(doc);
    return created.toObject() as TaskDoc;
  },
  async byId(id: string): Promise<TaskDoc | null> {
    const _id = oid(id);
    return _id ? TaskModel().findById(_id).lean<TaskDoc>() : null;
  },
  // Update and return the new document. `filter` narrows the match (e.g. an unclaimed alert stamp),
  // so a null result means "someone else got there first".
  async update(id: string, update: Record<string, unknown>, filter: Record<string, unknown> = {}): Promise<TaskDoc | null> {
    const _id = oid(id);
    if (!_id) return null;
    const hasOperator = Object.keys(update).some((k) => k.startsWith('$'));
    return TaskModel().findOneAndUpdate({ _id, ...filter }, hasOperator ? update : { $set: update }, { returnDocument: 'after' }).lean<TaskDoc>();
  },
  find(filter: Record<string, unknown>, limit = 500): Promise<TaskDoc[]> {
    return TaskModel().find(filter).sort({ dueAt: 1, createdAt: 1 }).limit(limit).lean<TaskDoc[]>();
  },
  async addHistory(rows: HistoryRow[]): Promise<void> {
    if (!rows.length) return;
    await TaskHistoryModel().insertMany(rows.map((r) => ({ oldValue: null, newValue: null, comment: null, ...r })));
  },
  history(taskId: string): Promise<TaskHistoryDoc[]> {
    return TaskHistoryModel().find({ taskId }).sort({ createdAt: 1, _id: 1 }).lean<TaskHistoryDoc[]>();
  },
  notifications(userId: string, limit = 50): Promise<TaskNotificationDoc[]> {
    return TaskNotificationModel().find({ userId }).sort({ sentAt: -1 }).limit(limit).lean<TaskNotificationDoc[]>();
  },
  async markNotificationsOpened(userId: string, ids: string[] | null): Promise<number> {
    const filter: Record<string, unknown> = { userId, openedAt: null };
    if (ids) filter._id = { $in: ids.map(oid).filter(Boolean) };
    const r = await TaskNotificationModel().updateMany(filter, { $set: { openedAt: new Date() } });
    return r.modifiedCount ?? 0;
  },
};
