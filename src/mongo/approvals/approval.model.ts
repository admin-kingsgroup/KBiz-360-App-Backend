import { Schema, type Model, type Types } from 'mongoose';
import { appDb } from '../connection';

// A general-purpose APPROVAL REQUEST ("Salary release approval", "Client visit expense"…) that
// travels a chain of LEVELS the requester builds themselves: any number of levels, one or more
// approvers on each. The request reaches the levels strictly in order — level 2 never sees it
// until level 1 is done; one rejection anywhere ends it. App-owned workflow on real CRM user ids,
// so the collection lives in kb360_app.
export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'cancelled';
// waiting = not reached yet · pending = it is THIS person's / level's turn · skipped = the request
// ended (rejected / withdrawn) before this was reached, or the level closed without needing them
// (mode "any" — somebody else on the level approved first).
export type ApprovalStepStatus = 'waiting' | 'pending' | 'approved' | 'rejected' | 'skipped';
// all = every approver on the level must approve before it moves on · any = the first approval
// closes the level. A reject by anyone on the level ends the request in both modes.
export type ApprovalLevelMode = 'all' | 'any';

export interface ApprovalApprover {
  userId: string; // CRM user id
  status: ApprovalStepStatus;
  decidedAt: Date | null;
  note: string;
}

export interface ApprovalLevel {
  order: number; // 1-based
  key: string | null; // role key when the level came from the fixed role chain ('branch_manager'…), else null
  label: string; // frozen at submit time ('Level 1', 'Finance', 'Branch manager') so old requests read the same forever
  mode: ApprovalLevelMode;
  status: ApprovalStepStatus;
  decidedAt: Date | null; // when the level closed (approved / rejected)
  approvers: ApprovalApprover[];
}

export interface ApprovalDoc {
  _id: Types.ObjectId;
  tenantId: string | null;
  requesterId: string; // CRM user id
  title: string;
  details: string;
  category: string; // 'Salary' | 'Holiday' | 'Expense' | 'HR' | … | 'General'
  status: ApprovalStatus;
  currentLevel: number; // 0-based index of the level awaiting decisions (= levels.length once approved)
  levels: ApprovalLevel[];
  submittedAt: Date;
  decidedAt: Date | null; // when the request reached a final status
  createdAt: Date;
  updatedAt: Date;
}

// The shape written before N-level chains (one approver per role step). Only the boot migration
// still reads it — see approval.migrate.ts.
export type ApprovalStepKey = 'branch_manager' | 'company_manager' | 'business_owner';
export interface ApprovalStep {
  key: ApprovalStepKey | string;
  label: string;
  approverId: string;
  status: ApprovalStepStatus;
  decidedAt: Date | null;
  note: string;
}
export interface LegacyApprovalDoc {
  _id: Types.ObjectId;
  currentStep?: number;
  steps: ApprovalStep[];
}

const ApproverSchema = new Schema<ApprovalApprover>(
  {
    userId: { type: String, required: true },
    status: { type: String, required: true, default: 'waiting' },
    decidedAt: { type: Date, default: null },
    note: { type: String, default: '' },
  },
  { _id: false },
);

const LevelSchema = new Schema<ApprovalLevel>(
  {
    order: { type: Number, required: true },
    key: { type: String, default: null },
    label: { type: String, required: true },
    mode: { type: String, required: true, default: 'all' },
    status: { type: String, required: true, default: 'waiting' },
    decidedAt: { type: Date, default: null },
    approvers: { type: [ApproverSchema], required: true },
  },
  { _id: false },
);

const ApprovalSchema = new Schema<ApprovalDoc>(
  {
    tenantId: { type: String, default: null },
    requesterId: { type: String, required: true },
    title: { type: String, required: true },
    details: { type: String, required: true },
    category: { type: String, default: 'General' },
    status: { type: String, required: true, default: 'pending' },
    currentLevel: { type: Number, required: true, default: 0 },
    levels: { type: [LevelSchema], required: true },
    submittedAt: { type: Date, default: Date.now },
    decidedAt: { type: Date, default: null },
  },
  { timestamps: true, collection: 'approval_requests' },
);
ApprovalSchema.index({ requesterId: 1, status: 1, submittedAt: -1 });
ApprovalSchema.index({ 'levels.approvers.userId': 1, status: 1, submittedAt: -1 });

let _Approval: Model<ApprovalDoc> | null = null;
export function ApprovalModel(): Model<ApprovalDoc> {
  if (!_Approval) _Approval = appDb().model<ApprovalDoc>('ApprovalRequest', ApprovalSchema);
  return _Approval;
}

export async function ensureApprovalIndexes(): Promise<void> {
  await ApprovalModel().createIndexes();
}
