import { Schema, type Model, type Types } from 'mongoose';
import { appDb } from '../connection';

// A general-purpose APPROVAL REQUEST ("Salary release approval", "Client visit expense"…) that
// travels a CHAIN: the requester names one approver per hierarchy step (branch manager → company
// manager → business owner) and the request reaches them strictly in that order — step 2 never
// sees it until step 1 approves; one rejection anywhere ends it. App-owned workflow on real CRM
// user ids, so the collection lives in kb360_app.
export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'cancelled';
// waiting = not reached yet · pending = it is THIS approver's turn · skipped = the request ended
// (rejected / withdrawn) before this step was reached.
export type ApprovalStepStatus = 'waiting' | 'pending' | 'approved' | 'rejected' | 'skipped';
export type ApprovalStepKey = 'branch_manager' | 'company_manager' | 'business_owner';

export interface ApprovalStep {
  key: ApprovalStepKey;
  label: string; // frozen at submit time ('Branch manager') so old requests read the same forever
  approverId: string; // CRM user id
  status: ApprovalStepStatus;
  decidedAt: Date | null;
  note: string;
}

export interface ApprovalDoc {
  _id: Types.ObjectId;
  tenantId: string | null;
  requesterId: string; // CRM user id
  title: string;
  details: string;
  category: string; // 'Salary' | 'Holiday' | 'Expense' | 'HR' | … | 'General'
  status: ApprovalStatus;
  currentStep: number; // 0-based index of the step awaiting a decision (= steps.length once approved)
  steps: ApprovalStep[];
  submittedAt: Date;
  decidedAt: Date | null; // when the request reached a final status
  createdAt: Date;
  updatedAt: Date;
}

const StepSchema = new Schema<ApprovalStep>(
  {
    key: { type: String, required: true },
    label: { type: String, required: true },
    approverId: { type: String, required: true },
    status: { type: String, required: true, default: 'waiting' },
    decidedAt: { type: Date, default: null },
    note: { type: String, default: '' },
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
    currentStep: { type: Number, required: true, default: 0 },
    steps: { type: [StepSchema], required: true },
    submittedAt: { type: Date, default: Date.now },
    decidedAt: { type: Date, default: null },
  },
  { timestamps: true, collection: 'approval_requests' },
);
ApprovalSchema.index({ requesterId: 1, status: 1, submittedAt: -1 });
ApprovalSchema.index({ 'steps.approverId': 1, status: 1, submittedAt: -1 });

let _Approval: Model<ApprovalDoc> | null = null;
export function ApprovalModel(): Model<ApprovalDoc> {
  if (!_Approval) _Approval = appDb().model<ApprovalDoc>('ApprovalRequest', ApprovalSchema);
  return _Approval;
}

export async function ensureApprovalIndexes(): Promise<void> {
  await ApprovalModel().createIndexes();
}
