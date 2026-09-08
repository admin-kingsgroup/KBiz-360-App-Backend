import { Schema, type Model, type Types } from 'mongoose';
import { appDb } from '../connection';

// An attendance-regularisation REQUEST: the person asks for a day's punch to be corrected
// ("I was in by 9:40, the app never fired" / "forgot to check out"); a manager approves and the
// day is corrected through the SAME evidence-preserving path the admin editor uses
// (attendanceService.applyAdminTimes) — or rejects with a note. App-owned workflow, so the
// collection lives in kb360_app; the ERP keeps reading the corrected day from `attendance`.
export interface RegularizationDoc {
  _id: Types.ObjectId;
  userId: string; // CRM user id (the requester)
  dateKey: string; // 'YYYY-MM-DD' business-tz day being corrected
  checkInAt: Date;
  checkOutAt: Date | null; // null = leave today open (past days always carry one)
  reason: string;
  status: string; // 'pending' | 'approved' | 'rejected' | 'cancelled'
  appliedAt: Date;
  decidedBy: string | null; // admin user id
  decidedAt: Date | null;
  decisionNote: string;
  createdAt: Date;
  updatedAt: Date;
}

const RegularizationSchema = new Schema<RegularizationDoc>(
  {
    userId: { type: String, required: true },
    dateKey: { type: String, required: true },
    checkInAt: { type: Date, required: true },
    checkOutAt: { type: Date, default: null },
    reason: { type: String, required: true },
    status: { type: String, required: true, default: 'pending' },
    appliedAt: { type: Date, default: Date.now },
    decidedBy: { type: String, default: null },
    decidedAt: { type: Date, default: null },
    decisionNote: { type: String, default: '' },
  },
  { timestamps: true, collection: 'attendance_regularizations' },
);
// NOT unique on (userId, dateKey): a rejected day may be re-requested. One PENDING per day is
// enforced in the service instead.
RegularizationSchema.index({ userId: 1, dateKey: 1 });
RegularizationSchema.index({ status: 1, appliedAt: -1 });

let _Regularization: Model<RegularizationDoc> | null = null;
export function RegularizationModel(): Model<RegularizationDoc> {
  if (!_Regularization) _Regularization = appDb().model<RegularizationDoc>('AttendanceRegularization', RegularizationSchema);
  return _Regularization;
}

export async function ensureRegularizationIndexes(): Promise<void> {
  await RegularizationModel().createIndexes();
}
