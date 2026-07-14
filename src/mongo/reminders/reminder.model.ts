import { Schema, type Model, type Types } from 'mongoose';
import { appDb } from '../connection';

// Reminders on REAL CRM user ids (forId/byId = CRM user _id), consistent with chat/calls.
// State machine (mirrors the app): pending → (assignee completes) → review (if set by someone else)
// or approved (if self-assigned) → (creator approves) → approved (archived).
export type ReminderState = 'pending' | 'review' | 'approved';

export interface ReminderDoc {
  _id: Types.ObjectId;
  text: string;
  section: string; // 'today' | 'week' | ... (open-ended, matches the app)
  forId: string; // assignee (CRM user id)
  byId: string; // creator (CRM user id)
  state: ReminderState;
  whenLabel: string | null; // 'Today · 2:00 PM'
  dueDate: string | null;
  dueAt: Date | null; // real due timestamp — drives due-time push + overdue
  dueNotifiedAt: Date | null; // when the "reminder due" push was sent (null = not yet)
  overdue: boolean;
  completedAt: Date | null;
  approvedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const ReminderSchema = new Schema<ReminderDoc>(
  {
    text: { type: String, required: true },
    section: { type: String, default: 'today' },
    forId: { type: String, required: true },
    byId: { type: String, required: true },
    state: { type: String, enum: ['pending', 'review', 'approved'], default: 'pending' },
    whenLabel: { type: String, default: null },
    dueDate: { type: String, default: null },
    dueAt: { type: Date, default: null },
    dueNotifiedAt: { type: Date, default: null },
    overdue: { type: Boolean, default: false },
    completedAt: { type: Date, default: null },
    approvedAt: { type: Date, default: null },
  },
  { timestamps: true, collection: 'reminders' },
);
ReminderSchema.index({ forId: 1, state: 1, createdAt: -1 });
ReminderSchema.index({ byId: 1, state: 1, createdAt: -1 });
ReminderSchema.index({ state: 1, createdAt: -1 });
ReminderSchema.index({ state: 1, dueAt: 1, dueNotifiedAt: 1 }); // due-time sweep

let _Reminder: Model<ReminderDoc> | null = null;
export function ReminderModel(): Model<ReminderDoc> {
  if (!_Reminder) _Reminder = appDb().model<ReminderDoc>('Reminder', ReminderSchema);
  return _Reminder;
}

export async function ensureReminderIndexes(): Promise<void> {
  await ReminderModel().createIndexes();
}
