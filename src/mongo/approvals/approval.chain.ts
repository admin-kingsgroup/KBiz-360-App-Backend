import { AppError, BadRequest, Forbidden } from '../../common/errors';
import type { ApprovalLevel, ApprovalLevelMode, ApprovalStatus, ApprovalStep, ApprovalStepKey, ApprovalStepStatus } from './approval.model';

// The PURE half of the approval chain (no DB I/O — exported for tests): how the submitted levels
// become a stored chain, what one approve/reject does to it, who it has reached, and the fixed
// role hierarchy that the old form still sends (and the new form may offer as a suggestion). The
// service wraps these with the reads, the atomic write and the notifications.

export const APPROVAL_CATEGORIES = ['Salary', 'Holiday', 'Leave', 'Expense', 'Purchase', 'Travel', 'HR', 'General'] as const;
export const APPROVAL_LIMITS = {
  title: 120,
  details: 2000,
  note: 500,
  label: 40, // a level's name
  levels: 10, // levels per request
  approversPerLevel: 10,
} as const;
export const LEVEL_MODES: readonly ApprovalLevelMode[] = ['all', 'any'];
export const DEFAULT_LEVEL_MODE: ApprovalLevelMode = 'all';

// ── the fixed role hierarchy (legacy form + suggestion for the new one) ─────────────────────────

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

/** The role-based steps a requester would get, each with the people who may be picked for it.
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

// ── building the chain ──────────────────────────────────────────────────────────────────────────

const newLevel = (order: number, key: string | null, label: string, mode: ApprovalLevelMode, approverIds: string[]): ApprovalLevel => {
  const status: ApprovalStepStatus = order === 1 ? 'pending' : 'waiting';
  return { order, key, label, mode, status, decidedAt: null, approvers: approverIds.map((userId) => ({ userId, status, decidedAt: null, note: '' })) };
};

export interface LevelInput {
  label?: string;
  mode?: string;
  approverIds: string[];
}

/** The requester's own levels → the stored chain. Level 1 (and everyone on it) starts `pending`,
 *  the rest `waiting`. Enforced here, never trusted from the client: at least one level, at least
 *  one approver per level, a known mode, nobody twice, never the requester, and only people who
 *  can act (`poolIds` = active, app-enabled, same tenant — the service builds it). */
export function planLevels(requesterId: string, poolIds: ReadonlySet<string>, input: LevelInput[]): ApprovalLevel[] {
  if (!input.length) throw BadRequest('Add at least one approval level');
  if (input.length > APPROVAL_LIMITS.levels) throw BadRequest(`A request can have at most ${APPROVAL_LIMITS.levels} levels`);
  const seen = new Set<string>();
  return input.map((lv, i) => {
    const order = i + 1;
    const label = String(lv.label ?? '').trim().slice(0, APPROVAL_LIMITS.label) || `Level ${order}`;
    const mode = (lv.mode ?? DEFAULT_LEVEL_MODE) as ApprovalLevelMode;
    if (!LEVEL_MODES.includes(mode)) throw BadRequest(`${label}: mode must be "all" or "any"`);
    const ids = [...new Set((lv.approverIds ?? []).map((s) => String(s).trim()).filter(Boolean))];
    if (!ids.length) throw BadRequest(`${label} has no approver — add at least one person`);
    if (ids.length > APPROVAL_LIMITS.approversPerLevel) throw BadRequest(`${label}: at most ${APPROVAL_LIMITS.approversPerLevel} approvers on one level`);
    for (const id of ids) {
      if (id === requesterId) throw BadRequest(`${label}: you cannot be an approver on your own request`);
      if (seen.has(id)) throw BadRequest(`${label}: that person is already on an earlier level — one level per person`);
      if (!poolIds.has(id)) throw BadRequest(`${label}: one of the people picked cannot approve on the app (inactive, no App Access, or another company) — pick from the approver list`);
      seen.add(id);
    }
    return newLevel(order, null, label, mode, ids);
  });
}

export interface ApproverPick {
  step: string;
  userId: string;
}

/** LEGACY form body (`approvers: [{ step, userId }]`): the fixed role hierarchy, one person per
 *  step → one single-approver level per step. EVERY step the hierarchy offers must be filled,
 *  each with one of that step's own candidates. */
export function planChain(hierarchy: HierarchyStep[], picks: ApproverPick[]): ApprovalLevel[] {
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
    return newLevel(i + 1, h.def.key, h.def.label, 'all', [pick.userId]);
  });
}

/** Pre-N-level documents (one approver per step) → levels, for the boot migration. */
export function levelsFromLegacySteps(steps: ApprovalStep[]): ApprovalLevel[] {
  return steps.map((s, i) => ({
    order: i + 1,
    key: s.key,
    label: s.label,
    mode: 'all',
    status: s.status,
    decidedAt: s.decidedAt ?? null,
    approvers: [{ userId: s.approverId, status: s.status, decidedAt: s.decidedAt ?? null, note: s.note ?? '' }],
  }));
}

// ── deciding ────────────────────────────────────────────────────────────────────────────────────

export interface ChainState {
  status: ApprovalStatus;
  currentLevel: number;
  levels: Array<{ mode: ApprovalLevelMode; status: ApprovalStepStatus; approvers: Array<{ userId: string; status: ApprovalStepStatus }> }>;
}

export interface DecisionPlan {
  levelIndex: number; // the level this decision lands on
  approverIndex: number; // the decider's slot on that level
  assert: Record<string, unknown>; // extra filter for the atomic write: the level exactly as it was read
  set: Record<string, unknown>; // $set for the atomic write
  status: ApprovalStatus; // the request's status afterwards
  levelClosed: boolean; // this decision finished the level
  nextApproverIds: string[]; // who it moves to (level closed by approve, more levels to go)
  waitingOnIds: string[]; // still to decide on this level (mode "all", level not closed yet)
}

/** One approve/reject by `userId`. Only someone whose TURN it is — pending on the current level —
 *  may decide. Approve: the level closes when everyone on it has approved (mode "all") or at the
 *  first approval (mode "any"); a closed level hands the request to the next one, or finishes it.
 *  Reject: ends the request at once; everyone still undecided is skipped. */
export function planDecision(doc: ChainState, userId: string, action: 'approve' | 'reject', note: string, now: Date): DecisionPlan {
  if (doc.status !== 'pending') throw new AppError(409, `This request is already ${doc.status}`, 'NOT_PENDING');
  const i = doc.currentLevel;
  const level = doc.levels[i];
  const j = level ? level.approvers.findIndex((a) => a.userId === userId) : -1;
  if (!level || j === -1) {
    const mine = doc.levels.findIndex((l) => l.approvers.some((a) => a.userId === userId));
    if (mine === -1) throw Forbidden('You are not an approver on this request');
    if (mine < i) throw new AppError(409, 'Your level has already been decided', 'ALREADY_DECIDED');
    throw new AppError(409, 'It is not your turn yet — the earlier levels have to approve first', 'NOT_YOUR_TURN');
  }
  if (level.approvers[j].status !== 'pending') throw new AppError(409, 'You have already decided on this request', 'ALREADY_DECIDED');

  const p = (k: number): string => `levels.${i}.approvers.${k}`;
  // The write re-asserts every slot of the level as read: two people approving a mode-"all"
  // level at the same moment must not both conclude "someone is still pending".
  const assert: Record<string, unknown> = { [`${p(j)}.userId`]: userId };
  level.approvers.forEach((a, k) => {
    assert[`${p(k)}.status`] = a.status;
  });
  const set: Record<string, unknown> = {
    [`${p(j)}.status`]: action === 'approve' ? 'approved' : 'rejected',
    [`${p(j)}.decidedAt`]: now,
    [`${p(j)}.note`]: note,
  };
  const skipRest = (from: number): void => {
    for (let l = from; l < doc.levels.length; l++) {
      set[`levels.${l}.status`] = 'skipped';
      doc.levels[l].approvers.forEach((_a, k) => {
        set[`levels.${l}.approvers.${k}.status`] = 'skipped';
      });
    }
  };
  const base = { levelIndex: i, approverIndex: j, assert };

  if (action === 'reject') {
    level.approvers.forEach((a, k) => {
      if (k !== j && a.status === 'pending') set[`${p(k)}.status`] = 'skipped';
    });
    skipRest(i + 1);
    set[`levels.${i}.status`] = 'rejected';
    set[`levels.${i}.decidedAt`] = now;
    return { ...base, set: { ...set, status: 'rejected', decidedAt: now }, status: 'rejected', levelClosed: true, nextApproverIds: [], waitingOnIds: [] };
  }

  const stillPending = level.approvers.filter((a, k) => k !== j && a.status === 'pending').map((a) => a.userId);
  const closed = level.mode === 'any' || stillPending.length === 0;
  if (!closed) return { ...base, set, status: 'pending', levelClosed: false, nextApproverIds: [], waitingOnIds: stillPending };

  if (level.mode === 'any') {
    level.approvers.forEach((a, k) => {
      if (k !== j && a.status === 'pending') set[`${p(k)}.status`] = 'skipped';
    });
  }
  set[`levels.${i}.status`] = 'approved';
  set[`levels.${i}.decidedAt`] = now;
  const next = doc.levels[i + 1];
  if (!next) {
    return { ...base, set: { ...set, status: 'approved', decidedAt: now, currentLevel: doc.levels.length }, status: 'approved', levelClosed: true, nextApproverIds: [], waitingOnIds: [] };
  }
  set.currentLevel = i + 1;
  set[`levels.${i + 1}.status`] = 'pending';
  next.approvers.forEach((_a, k) => {
    set[`levels.${i + 1}.approvers.${k}.status`] = 'pending';
  });
  return { ...base, set, status: 'pending', levelClosed: true, nextApproverIds: next.approvers.map((a) => a.userId), waitingOnIds: [] };
}

/** Withdrawal by the requester: every undecided level (and everyone on it) is skipped. */
export function planCancel(doc: ChainState, now: Date): Record<string, unknown> {
  if (doc.status !== 'pending') throw new AppError(409, `Already ${doc.status} — only a pending request can be withdrawn`, 'NOT_PENDING');
  const set: Record<string, unknown> = { status: 'cancelled', decidedAt: now };
  doc.levels.forEach((l, li) => {
    if (l.status === 'pending' || l.status === 'waiting') set[`levels.${li}.status`] = 'skipped';
    l.approvers.forEach((a, k) => {
      if (a.status === 'pending' || a.status === 'waiting') set[`levels.${li}.approvers.${k}.status`] = 'skipped';
    });
  });
  return set;
}

// A request "comes to" an approver only when the chain reaches their LEVEL — a later level never
// sees it while an earlier one is still deciding, and never at all if it was rejected or
// withdrawn before them. Someone on a closed level keeps seeing it (also in mode "any" when a
// colleague approved first — their slot says `skipped`, but the level was theirs), and so does
// anyone who already decided their slot, even if the requester withdrew the request afterwards.
const REACHED: readonly string[] = ['pending', 'approved', 'rejected'];
export const hasReached = (doc: Pick<ChainState, 'levels'>, userId: string): boolean =>
  doc.levels.some((l) => l.approvers.some((a) => a.userId === userId && (REACHED.includes(l.status) || a.status === 'approved' || a.status === 'rejected')));
export const isTurnOf = (doc: ChainState, userId: string): boolean =>
  doc.status === 'pending' && (doc.levels[doc.currentLevel]?.approvers.some((a) => a.userId === userId && a.status === 'pending') ?? false);
/** Everyone still to decide on the current level (empty once the request is final). */
export const pendingApproverIds = (doc: ChainState): string[] =>
  doc.status === 'pending' ? (doc.levels[doc.currentLevel]?.approvers.filter((a) => a.status === 'pending').map((a) => a.userId) ?? []) : [];

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
