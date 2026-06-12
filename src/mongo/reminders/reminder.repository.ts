import { Types } from 'mongoose';
import { ReminderModel, type ReminderDoc } from './reminder.model';

const oid = (id: string): Types.ObjectId | null => (Types.ObjectId.isValid(id) ? new Types.ObjectId(id) : null);

export const reminderRepo = {
  create: (data: Partial<ReminderDoc>) => ReminderModel().create(data),
  byId: (id: string) => (oid(id) ? ReminderModel().findById(id).lean<ReminderDoc>() : Promise.resolve(null)),
  update: (id: string, set: Partial<ReminderDoc>) => ReminderModel().updateOne({ _id: oid(id) }, { $set: set }),
  remove: (id: string) => ReminderModel().deleteOne({ _id: oid(id) }),

  // Live = everything not yet approved (the working set for For me / I set / Review / All).
  listLive: () => ReminderModel().find({ state: { $ne: 'approved' } }).sort({ createdAt: 1 }).lean<ReminderDoc[]>(),

  // Archive = approved reminders the user is part of.
  listApproved: (userId: string) =>
    ReminderModel().find({ state: 'approved', $or: [{ forId: userId }, { byId: userId }] }).sort({ approvedAt: -1, createdAt: -1 }).lean<ReminderDoc[]>(),

  countReview: (byId: string) => ReminderModel().countDocuments({ state: 'review', byId }),
};
