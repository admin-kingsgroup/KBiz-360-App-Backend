import { AppError, BadRequest, Forbidden } from '../../common/errors';
import type { ApprovalStatus, ApprovalStep, ApprovalStepKey } from './approval.model';

// The PURE half of the approval chain (no DB I/O — exported for tests): which hierarchy steps a
// requester gets, who may sit on each, how a submitted form becomes a chain, and what one
// approve/reject does to it. The service wraps these with the reads, the atomic write and the
// notifications.

export interface ChainStepDef {
  key: ApprovalStepKey;
  label: string;
  rank: number; // CRM role level that fills the step (1 = super_admin … 3 = branch_manager)
}

// Review order, lowest authority first. The ranks are the CRM's role levels — "Business owner"
// is the super admin, exactly the people the rest of the app already treats as the owner.
export const CHAIN_STEPS: readonly ChainStepDef[] = [
  { key: 'branch_manager', label: 'Branch manager', rank: 3 },
  { key: 'company_manager', label: 'Company manager', rank: 2 },
  { key: 'business_owner', label: 'Business owner', rank: 1 },
];

export const APPROVAL_CATEGORIES = ['Salary', 'Holiday', 'Leave', 'Expense', 'Purchase', 'Travel', 'HR', 'General'] as const;
export const APPROVAL_LIMITS = { title: 120, details: 2000, note: 500 } as const;

export interface ChainPerson {
  id: string;
  level: number; // CRM role level (5 = employee when the role is missing)
  isSuper: boolean; // level 1 or the '*' permission
  branchIds: string[];
}

const rankOf = (p: ChainPerson): number => (p.isSuper ? 1 : p.level);

export interface HierarchyStep {
  def: ChainStepDef;
  candidateIds: string[];
}

/** The steps a requester's form shows, each with the people who may be picked for it.
 *  - Only steps that OUTRANK the requester apply: a branch manager's request starts at the
 *    company manager; a company manager's goes straight to the business owner. A business owner
 *    asks a fellow owner (the one case a peer decides).
 *  - Branch managers must share a branch with the requester — another branch's manager has no
 *    standing over them.
 *  - Nobody approves their own request, and a step nobody can fill is dropped rather than left
 *    as a dead end (a branch with no manager on the app goes straight to the company manager).
 *  `pool` = people who can actually act: active, app-enabled, same tenant (the service filters). */
export function hierarchyFor(requester: ChainPerson, pool: ChainPerson[]): HierarchyStep[] {
  const myRank = rankOf(requester);
  const out: HierarchyStep[] = [];
  for (const def of CHAIN_STEPS) {
    const applies = def.rank < myRank || (myRank === 1 && def.rank === 1);
    if (!applies) continue;
    const candidateIds = pool
      .filter((p) => p.id !== requester.id && rankOf(p) === def.rank)
      .filter((p) => def.key !== 'branch_manager' || p.branchIds.some((b) => requester.branchIds.includes(b)))
      .map((p) => p.id);
    if (candidateIds.length) out.push({ def, candidateIds });
  }
  return out;
}

export interface ApproverPick {
  step: string;
  userId: string;
}

/** Turn the submitted picks into the stored chain. EVERY step the hierarchy offers must be
 *  filled, each with one of that step's own candidates — so the order, the roles and the
 *  "not yourself" rule are all enforced here, never trusted from the client. */
export function planChain(hierarchy: HierarchyStep[], picks: ApproverPick[]): ApprovalStep[] {
  if (!hierarchy.length) {
    throw new AppError(422, 'There is nobody above you on the app who could approve this — ask the Super Admin to check roles and App Access', 'NO_APPROVERS');
  }
  const known = new Set(hierarchy.map((h) => h.def.key as string));
  const stray = picks.filter((p) => !known.has(p.step)).map((p) => p.step);
  if (stray.length) throw BadRequest(`Not a step of your approval hierarchy: ${[...new Set(stray)].join(', ')}`);
  const seen = new Set<string>();
  for (const p of picks) {
    if (seen.has(p.step)) throw BadRequest(`Pick one approver per step — "${p.step}" was sent twice`);
    seen.add(p.step);
  }
  const missing = hierarchy.filter((h) => !seen.has(h.def.key)).map((h) => h.def.label);
  if (missing.length) throw BadRequest(`Select an approver for: ${missing.join(', ')}`);

  return hierarchy.map((h, i) => {
    const pick = picks.find((p) => p.step === h.def.key)!;
    if (!h.candidateIds.includes(pick.userId)) throw BadRequest(`That person cannot approve as ${h.def.label} — pick one from the list`);
    return { key: h.def.key, label: h.def.label, approverId: pick.userId, status: i === 0 ? 'pending' : 'waiting', decidedAt: null, note: '' };
  });
}

export interface ChainState {
  status: ApprovalStatus;
  currentStep: number;
  steps: Pick<ApprovalStep, 'approverId' | 'status'>[];
}

export interface DecisionPlan {
  stepIndex: number; // the step this decision lands on
  set: Record<string, unknown>; // $set for the atomic write
  status: ApprovalStatus; // the request's status afterwards
  nextApproverId: string | null; // who it moves to (approve on a non-final step)
}

/** One approve/reject by `userId`. Only the approver whose TURN it is may decide; an approve
 *  hands the request to the next step (or finishes it), a reject ends it and skips the rest. */
export function planDecision(doc: ChainState, userId: string, action: 'approve' | 'reject', note: string, now: Date): DecisionPlan {
  if (doc.status !== 'pending') throw new AppError(409, `This request is already ${doc.status}`, 'NOT_PENDING');
  const i = doc.currentStep;
  const step = doc.steps[i];
  if (!step || step.approverId !== userId) {
    const mine = doc.steps.findIndex((s) => s.approverId === userId);
    if (mine === -1) throw Forbidden('You are not an approver on this request');
    if (mine < i) throw new AppError(409, 'You have already decided your step', 'ALREADY_DECIDED');
    throw new AppError(409, 'It is not your turn yet — the earlier steps have to approve first', 'NOT_YOUR_TURN');
  }

  const set: Record<string, unknown> = {
    [`steps.${i}.status`]: action === 'approve' ? 'approved' : 'rejected',
    [`steps.${i}.decidedAt`]: now,
    [`steps.${i}.note`]: note,
  };
  if (action === 'reject') {
    for (let j = i + 1; j < doc.steps.length; j++) set[`steps.${j}.status`] = 'skipped';
    return { stepIndex: i, set: { ...set, status: 'rejected', decidedAt: now }, status: 'rejected', nextApproverId: null };
  }
  const next = doc.steps[i + 1];
  if (!next) return { stepIndex: i, set: { ...set, status: 'approved', decidedAt: now, currentStep: doc.steps.length }, status: 'approved', nextApproverId: null };
  return {
    stepIndex: i,
    set: { ...set, currentStep: i + 1, [`steps.${i + 1}.status`]: 'pending' },
    status: 'pending',
    nextApproverId: next.approverId,
  };
}

/** Withdrawal by the requester: every undecided step is skipped. */
export function planCancel(doc: ChainState, now: Date): Record<string, unknown> {
  if (doc.status !== 'pending') throw new AppError(409, `Already ${doc.status} — only a pending request can be withdrawn`, 'NOT_PENDING');
  const set: Record<string, unknown> = { status: 'cancelled', decidedAt: now };
  doc.steps.forEach((s, j) => {
    if (s.status === 'pending' || s.status === 'waiting') set[`steps.${j}.status`] = 'skipped';
  });
  return set;
}

// A request "comes to" an approver only when the chain reaches them — a later step never sees
// it while an earlier one is still deciding, and never at all if it was rejected before them.
const REACHED: readonly string[] = ['pending', 'approved', 'rejected'];
export const hasReached = (doc: Pick<ChainState, 'steps'>, userId: string): boolean =>
  doc.steps.some((s) => s.approverId === userId && REACHED.includes(s.status));
export const isTurnOf = (doc: ChainState, userId: string): boolean =>
  doc.status === 'pending' && doc.steps[doc.currentStep]?.approverId === userId;

/** The card's "· Salary" tag when the form sent no category: read it off the title. */
export function inferCategory(title: string): string {
  const t = title.toLowerCase();
  if (/\b(salary|salaries|payroll|wages?|increment|bonus)\b/.test(t)) return 'Salary';
  if (/\bholidays?\b/.test(t)) return 'Holiday';
  if (/\b(leaves?|day off|time off)\b/.test(t)) return 'Leave';
  if (/\b(expenses?|reimburse\w*|claims?|petty cash)\b/.test(t)) return 'Expense';
  if (/\b(purchase|buy|procure\w*|vendor|quotation)\b/.test(t)) return 'Purchase';
  if (/\b(travel|flight|hotel|trip|visa)\b/.test(t)) return 'Travel';
  if (/\b(hr|work from home|wfh|hiring|recruit\w*|attendance|shift)\b/.test(t)) return 'HR';
  return 'General';
}
