import { Types } from 'mongoose';
import { AppError, BadRequest, Forbidden, NotFound } from '../../common/errors';
import { crmRepo, type CrmBranch, type CrmRole, type CrmUser } from '../crm.repo';
import { accessService, deriveAccess } from '../access';
import { appAccess } from '../appAccess';
import { userAvatars } from '../userAvatars';
import { userPositions } from '../userPositions';
import { emitToUsers } from '../chat/chat.events';
import { ApprovalModel, type ApprovalDoc, type ApprovalLevelMode, type ApprovalStatus } from './approval.model';
import { approvalPush } from './approval.push';
import {
  APPROVAL_CATEGORIES,
  APPROVAL_LIMITS,
  DEFAULT_LEVEL_MODE,
  LEVEL_MODES,
  hasReached,
  hierarchyFor,
  inferCategory,
  isTurnOf,
  pendingApproverIds,
  planCancel,
  planChain,
  planDecision,
  planLevels,
  type ApproverPick,
  type ChainPerson,
  type DecisionPlan,
  type LevelInput,
} from './approval.chain';

// Approval requests with a chain of LEVELS: request → level 1 → level 2 → … → approved, one
// rejection anywhere ends it. Identity is always the verified JWT's; the chain rules live in
// approval.chain (pure), this file does the reads, the atomic writes and tells people.

// ── display helpers (same avatar palette as reminders/attendance so a person keeps one colour) ──
const PALETTE = ['#9A6CF0', '#4F8BFF', '#37B6A4', '#E8A13A', '#E3674E', '#0C0E14'];
const colorFor = (id: string): string => PALETTE[[...id].reduce((n, c) => n + c.charCodeAt(0), 0) % PALETTE.length];
const nameOf = (u: CrmUser): string => `${u.first_name ?? ''} ${u.last_name ?? ''}`.trim() || u.email || 'Unknown';
const initialsOf = (name: string): string => name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]).join('').toUpperCase() || '?';

export interface PersonDto {
  id: string;
  name: string;
  initials: string;
  color: string;
  avatar: string | null;
  position: string | null;
}

/** A person the requester may put on a level — PersonDto plus what the picker shows next to the name. */
export interface ApproverCandidateDto extends PersonDto {
  email: string | null;
  role: string | null; // CRM role name ('branch_manager', 'super_admin'…)
  level: number; // CRM role level (1 = owner … 5 = employee)
  branches: string[]; // live branch codes ('BOM', 'NBO')
}

export interface ApprovalApproverDto {
  approver: PersonDto;
  status: string; // waiting | pending | approved | rejected | skipped
  decidedAt: string | null;
  note: string;
}

export interface ApprovalLevelDto {
  order: number; // 1-based
  key: string | null;
  label: string;
  mode: ApprovalLevelMode;
  status: string; // waiting | pending | approved | rejected | skipped
  isCurrent: boolean; // the level the request is sitting on right now
  decidedAt: string | null;
  approvedCount: number;
  requiredCount: number; // approvals that close the level: everyone (all) or 1 (any)
  approvers: ApprovalApproverDto[];
}

/** One row per approver, in chain order — what builds before N-level chains render. */
export interface ApprovalStepDto {
  order: number; // 1-based running row number (unique)
  level: number; // 1-based level the row belongs to
  key: string;
  label: string;
  approver: PersonDto;
  status: string;
  isCurrent: boolean;
  decidedAt: string | null;
  note: string;
}

export interface ApprovalDto {
  id: string;
  title: string;
  details: string;
  category: string;
  status: ApprovalStatus;
  submittedAt: string;
  decidedAt: string | null;
  requester: PersonDto;
  totalLevels: number;
  currentLevel: number | null; // 1-based order of the level awaiting decisions; null once final
  currentApprovers: PersonDto[]; // everyone still to decide on that level
  levels: ApprovalLevelDto[];
  // ── mirrors for the pre-N-level app build (one row per approver) ──
  totalSteps: number;
  currentStep: number | null;
  currentApprover: PersonDto | null;
  steps: ApprovalStepDto[];
  // ── relative to the caller ──
  isMine: boolean; // the caller raised it
  canAct: boolean; // it is the caller's turn → show Approve / Reject
  canCancel: boolean; // the caller may withdraw it
  myDecision: 'approved' | 'rejected' | null; // what the caller decided on their own level
}

const unknownPerson = (id: string): PersonDto => ({ id, name: 'Unknown', initials: '?', color: colorFor(id), avatar: null, position: null });

async function resolvePeople(ids: string[]): Promise<Map<string, PersonDto>> {
  const unique = [...new Set(ids)];
  const map = new Map<string, PersonDto>();
  const oids = unique.filter((id) => Types.ObjectId.isValid(id)).map((id) => new Types.ObjectId(id));
  if (!oids.length) return map;
  const [users, avatars, positions] = await Promise.all([
    crmRepo.listUsers({ _id: { $in: oids } }),
    userAvatars.mapFor(unique),
    userPositions.mapFor(unique),
  ]);
  for (const u of users) {
    const id = String(u._id);
    const name = nameOf(u);
    map.set(id, { id, name, initials: initialsOf(name), color: colorFor(id), avatar: avatars[id] ?? null, position: positions[id] ?? null });
  }
  return map;
}

const iso = (d: Date | null | undefined): string | null => (d ? new Date(d).toISOString() : null);

function present(doc: ApprovalDoc, people: Map<string, PersonDto>, viewerId: string): ApprovalDto {
  const person = (id: string): PersonDto => people.get(id) ?? unknownPerson(id);
  const pending = doc.status === 'pending';
  const current = pending ? doc.levels[doc.currentLevel] : undefined;
  const currentApprovers = pendingApproverIds(doc).map(person);
  const myDecided = doc.levels.flatMap((l) => l.approvers).find((a) => a.userId === viewerId && (a.status === 'approved' || a.status === 'rejected'));
  let row = 0;
  const steps: ApprovalStepDto[] = doc.levels.flatMap((l, i) =>
    l.approvers.map((a) => ({
      order: ++row,
      level: l.order,
      key: l.key ?? `level_${l.order}`,
      label: l.label,
      approver: person(a.userId),
      status: a.status,
      isCurrent: pending && i === doc.currentLevel && a.status === 'pending',
      decidedAt: iso(a.decidedAt),
      note: a.note ?? '',
    })),
  );
  return {
    id: String(doc._id),
    title: doc.title,
    details: doc.details,
    category: doc.category,
    status: doc.status,
    submittedAt: (doc.submittedAt ?? doc.createdAt).toISOString(),
    decidedAt: iso(doc.decidedAt),
    requester: person(doc.requesterId),
    totalLevels: doc.levels.length,
    currentLevel: current ? doc.currentLevel + 1 : null,
    currentApprovers,
    levels: doc.levels.map((l, i) => ({
      order: l.order,
      key: l.key ?? null,
      label: l.label,
      mode: l.mode,
      status: l.status,
      isCurrent: pending && i === doc.currentLevel,
      decidedAt: iso(l.decidedAt),
      approvedCount: l.approvers.filter((a) => a.status === 'approved').length,
      requiredCount: l.mode === 'any' ? 1 : l.approvers.length,
      approvers: l.approvers.map((a) => ({ approver: person(a.userId), status: a.status, decidedAt: iso(a.decidedAt), note: a.note ?? '' })),
    })),
    totalSteps: doc.levels.length,
    currentStep: current ? doc.currentLevel + 1 : null,
    currentApprover: currentApprovers[0] ?? null,
    steps,
    isMine: doc.requesterId === viewerId,
    canAct: isTurnOf(doc, viewerId),
    canCancel: pending && doc.requesterId === viewerId,
    myDecision: myDecided ? (myDecided.status as 'approved' | 'rejected') : null,
  };
}

const everyoneOn = (doc: ApprovalDoc): string[] => doc.levels.flatMap((l) => l.approvers.map((a) => a.userId));

async function presentMany(docs: ApprovalDoc[], viewerId: string): Promise<ApprovalDto[]> {
  const people = await resolvePeople(docs.flatMap((d) => [d.requesterId, ...everyoneOn(d)]));
  return docs.map((d) => present(d, people, viewerId));
}
const presentOne = async (doc: ApprovalDoc, viewerId: string): Promise<ApprovalDto> => (await presentMany([doc], viewerId))[0];

// The pool = people who can actually ACT on a request: active, App Access on in the ERP, not
// switched off in the app, same tenant. An approver who cannot open the app would strand the chain.
// Tenant rule = the one every admin read here uses: only a PRESENT-and-different tenant excludes
// (several live users, super admins among them, carry no tenant_id at all).
// Branch overlap counts LIVE branches only — users still hold ids of branch rows that were
// retired from the CRM, and sharing a dead id must not make a stranger "your" branch manager.
interface Pool {
  me: CrmUser;
  mePerson: ChainPerson;
  people: ChainPerson[]; // everyone who can act, the requester excluded
  users: Map<string, CrmUser>;
  roleById: Map<string, CrmRole>;
  branchById: Map<string, CrmBranch>;
}

async function poolFor(userId: string): Promise<Pool> {
  const me = await crmRepo.getUserById(userId);
  if (!me) throw Forbidden('Session user not found');
  const [users, roles, branches, disabled] = await Promise.all([
    crmRepo.listUsers({ status: 'active' }),
    crmRepo.listRoles(),
    crmRepo.listBranches(),
    appAccess.disabledSet(),
  ]);
  const roleById = new Map<string, CrmRole>(roles.map((r) => [String(r._id), r]));
  const branchById = new Map<string, CrmBranch>(branches.map((b) => [String(b._id), b]));
  const toChainPerson = (u: CrmUser): ChainPerson => {
    const a = deriveAccess(u, u.role_id ? roleById.get(String(u.role_id)) ?? null : null);
    return { id: a.userId, level: a.level, isSuper: a.isSuper, branchIds: (u.branch_ids ?? []).map(String).filter((b) => branchById.has(b)) };
  };
  const sameTenant = (u: CrmUser): boolean => !(me.tenant_id && u.tenant_id && String(u.tenant_id) !== String(me.tenant_id));
  const canAct = users.filter((u) => String(u._id) !== userId && u.access?.app === true && !disabled.has(String(u._id)) && sameTenant(u));
  return { me, mePerson: toChainPerson(me), people: canAct.map(toChainPerson), users: new Map(canAct.map((u) => [String(u._id), u])), roleById, branchById };
}

async function candidatesOf(pool: Pool): Promise<ApproverCandidateDto[]> {
  const ids = pool.people.map((p) => p.id);
  const people = await resolvePeople(ids);
  return ids
    .map((id) => {
      const u = pool.users.get(id)!;
      const r = u.role_id ? pool.roleById.get(String(u.role_id)) : undefined;
      const branches = (u.branch_ids ?? []).map((b) => pool.branchById.get(String(b))?.code ?? '').filter(Boolean);
      return { ...(people.get(id) ?? unknownPerson(id)), email: u.email ?? null, role: r?.name ?? null, level: r?.level ?? 5, branches };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

// What a viewer may see: their own requests + the ones the chain has brought to them — a level
// they sit on that has been reached (pending, approved or rejected; never a waiting/skipped one),
// or a slot they already decided (kept even if the requester withdrew the request afterwards).
const REACHED: readonly string[] = ['pending', 'approved', 'rejected'];
const reachedMe = (me: string): Record<string, unknown> => ({
  $or: [
    { levels: { $elemMatch: { status: { $in: REACHED }, 'approvers.userId': me } } },
    { levels: { $elemMatch: { approvers: { $elemMatch: { userId: me, status: { $in: ['approved', 'rejected'] } } } } } },
  ],
});
const myTurn = (me: string): Record<string, unknown> => ({ status: 'pending', levels: { $elemMatch: { status: 'pending', approvers: { $elemMatch: { userId: me, status: 'pending' } } } } });

export type ApprovalScope = 'all' | 'mine' | 'assigned' | 'actionable';
function scopeFilter(me: string, scope: ApprovalScope): Record<string, unknown> {
  if (scope === 'mine') return { requesterId: me };
  if (scope === 'assigned') return reachedMe(me);
  if (scope === 'actionable') return myTurn(me);
  return { $or: [{ requesterId: me }, reachedMe(me)] };
}

export interface ApprovalCounts {
  all: number;
  pending: number;
  approved: number;
  rejected: number;
  cancelled: number;
  actionable: number; // waiting on the caller right now — the tab badge
}

async function countsFor(me: string, scope: ApprovalScope): Promise<ApprovalCounts> {
  const [byStatus, actionable] = await Promise.all([
    ApprovalModel().aggregate<{ _id: string; n: number }>([{ $match: scopeFilter(me, scope) }, { $group: { _id: '$status', n: { $sum: 1 } } }]),
    ApprovalModel().countDocuments(myTurn(me)),
  ]);
  const n = (s: string): number => byStatus.find((r) => r._id === s)?.n ?? 0;
  return { all: byStatus.reduce((t, r) => t + r.n, 0), pending: n('pending'), approved: n('approved'), rejected: n('rejected'), cancelled: n('cancelled'), actionable };
}

// Everyone the request has touched so far (requester + everyone it has reached, same rule as
// reachedMe) — they get the bare-id `approval:update` signal and refetch through the
// access-filtered REST reads.
const audienceOf = (doc: ApprovalDoc): string[] => [
  ...new Set([doc.requesterId, ...doc.levels.flatMap((l) => l.approvers.filter((a) => REACHED.includes(l.status) || a.status === 'approved' || a.status === 'rejected').map((a) => a.userId))]),
];

export interface ApprovalCreateBody {
  title: string;
  details: string;
  category?: string;
  levels?: LevelInput[]; // the requester's own chain
  approvers?: ApproverPick[]; // LEGACY: one pick per fixed role step
}

export const approvalService = {
  /** GET /approvals/hierarchy — everything the New request form needs: the level-builder limits,
   *  the people who can be put on a level, a suggested role-based chain, and (for the previous
   *  app build) the fixed role steps with their candidates. */
  async hierarchy(userId: string) {
    const pool = await poolFor(userId);
    const steps = hierarchyFor(pool.mePerson, pool.people);
    const approvers = await candidatesOf(pool);
    const byId = new Map(approvers.map((c) => [c.id, c]));
    const personOf = (id: string): PersonDto => {
      const c = byId.get(id);
      return c ? { id: c.id, name: c.name, initials: c.initials, color: c.color, avatar: c.avatar, position: c.position } : unknownPerson(id);
    };
    return {
      // ── the level builder ──
      levels: {
        min: 1,
        max: APPROVAL_LIMITS.levels,
        maxApproversPerLevel: APPROVAL_LIMITS.approversPerLevel,
        labelMaxLength: APPROVAL_LIMITS.label,
        modes: LEVEL_MODES,
        defaultMode: DEFAULT_LEVEL_MODE,
      },
      approvers,
      // A ready-made chain by role (branch manager → company manager → business owner) the form
      // may offer as a starting point; a step with exactly one candidate is pre-filled.
      suggestedLevels: steps.map((s, i) => ({
        order: i + 1,
        label: s.def.label,
        mode: DEFAULT_LEVEL_MODE,
        approverIds: s.candidateIds.length === 1 ? s.candidateIds : [],
        candidateIds: s.candidateIds,
      })),
      // ── the fixed role chain (previous app build) ──
      totalSteps: steps.length,
      steps: steps.map((s, i) => {
        const candidates = s.candidateIds.map(personOf).sort((a, b) => a.name.localeCompare(b.name));
        return {
          order: i + 1,
          key: s.def.key,
          label: s.def.label,
          placeholder: `Select ${s.def.label.toLowerCase()}`,
          required: true,
          defaultApproverId: candidates.length === 1 ? candidates[0].id : null,
          candidates,
        };
      }),
      categories: APPROVAL_CATEGORIES,
      limits: APPROVAL_LIMITS,
    };
  },

  /** GET /approvals/approvers?q= — the people picker for a level: everyone in the caller's tenant
   *  who can act on a request (active, App Access on, not switched off), the caller excluded. */
  async approvers(userId: string, opts: { q?: string; limit: number }): Promise<{ total: number; items: ApproverCandidateDto[] }> {
    const all = await candidatesOf(await poolFor(userId));
    const q = (opts.q ?? '').trim().toLowerCase();
    const hit = (c: ApproverCandidateDto): boolean =>
      !q || [c.name, c.email ?? '', c.role ?? '', c.position ?? '', ...c.branches].some((s) => s.toLowerCase().includes(q));
    const items = all.filter(hit);
    return { total: items.length, items: items.slice(0, opts.limit) };
  },

  /** POST /approvals — raise a request. The chain is rebuilt server-side from the caller's own
   *  pool, so a pick outside it (not on the app, other tenant, yourself, twice) is refused. The
   *  legacy `approvers` body still works: it becomes one single-person level per role step. */
  async create(userId: string, body: ApprovalCreateBody): Promise<ApprovalDto> {
    const title = body.title.trim();
    const details = body.details.trim();
    if (!title) throw BadRequest('Give the request a title');
    if (!details) throw BadRequest('Explain what needs approval');
    const pool = await poolFor(userId);
    const levels = body.levels?.length
      ? planLevels(userId, new Set(pool.people.map((p) => p.id)), body.levels)
      : body.approvers?.length
        ? planChain(hierarchyFor(pool.mePerson, pool.people), body.approvers)
        : (() => {
            throw BadRequest('Add at least one approval level');
          })();
    const category = (body.category ?? '').trim() || inferCategory(title);

    const doc = await ApprovalModel().create({
      tenantId: pool.me.tenant_id ? String(pool.me.tenant_id) : null,
      requesterId: userId,
      title,
      details,
      category,
      status: 'pending',
      currentLevel: 0,
      levels,
      submittedAt: new Date(),
    });
    const saved = doc.toObject() as ApprovalDoc;
    const id = String(saved._id);

    // It comes to level 1 only — later levels hear nothing until it reaches them.
    const first = levels[0].approvers.map((a) => a.userId);
    emitToUsers(first, 'approval:new', { id });
    const requesterName = nameOf(pool.me);
    for (const uid of first) void approvalPush.sendYourTurn(uid, requesterName, title, id);

    return presentOne(saved, userId);
  },

  /** GET /approvals?scope=&status=&page=&limit= — newest first, with the chip counts. */
  async list(userId: string, opts: { scope: ApprovalScope; status?: ApprovalStatus; page: number; limit: number }) {
    const filter = { ...scopeFilter(userId, opts.scope), ...(opts.status && opts.scope !== 'actionable' ? { status: opts.status } : {}) };
    const [rows, total, counts] = await Promise.all([
      ApprovalModel().find(filter).sort({ submittedAt: -1, _id: -1 }).skip((opts.page - 1) * opts.limit).limit(opts.limit).lean(),
      ApprovalModel().countDocuments(filter),
      countsFor(userId, opts.scope),
    ]);
    return {
      scope: opts.scope,
      status: opts.status ?? null,
      page: opts.page,
      limit: opts.limit,
      total,
      hasMore: opts.page * opts.limit < total,
      counts,
      items: await presentMany(rows as ApprovalDoc[], userId),
    };
  },

  /** GET /approvals/counts — cheap numbers for the tab badge + filter chips. */
  async counts(userId: string): Promise<ApprovalCounts> {
    return countsFor(userId, 'all');
  },

  /** GET /approvals/:id — the requester, an approver on a level the chain has reached, or a
   *  super admin of the same tenant. Anyone else gets 404, not 403 — a later level must not
   *  learn it exists. */
  async get(userId: string, id: string): Promise<ApprovalDto> {
    const doc = await this.visibleDoc(userId, id);
    return presentOne(doc, userId);
  },

  async visibleDoc(userId: string, id: string): Promise<ApprovalDoc> {
    if (!Types.ObjectId.isValid(id)) throw NotFound('No such request');
    const doc = (await ApprovalModel().findById(id).lean()) as ApprovalDoc | null;
    if (!doc) throw NotFound('No such request');
    if (doc.requesterId === userId || hasReached(doc, userId)) return doc;
    const viewer = await accessService.accessForUserId(userId);
    if (viewer?.isSuper && (!viewer.tenantId || !doc.tenantId || viewer.tenantId === doc.tenantId)) return doc;
    throw NotFound('No such request');
  },

  /** PUT /approvals/:id/decision { action, note? } — approve closes the caller's slot (and the
   *  level, when it has what it needs — then the next level is told); reject ends it. Only
   *  someone whose TURN it is may decide. */
  async decide(userId: string, id: string, body: { action: 'approve' | 'reject'; note?: string }): Promise<ApprovalDto> {
    if (!Types.ObjectId.isValid(id)) throw NotFound('No such request');
    const before = (await ApprovalModel().findById(id).lean()) as ApprovalDoc | null;
    // A stranger learns nothing, not even that it exists; someone ON the chain gets the precise
    // refusal from planDecision (NOT_YOUR_TURN / ALREADY_DECIDED / NOT_PENDING).
    if (!before || !everyoneOn(before).includes(userId)) throw NotFound('No such request');
    const note = String(body.note ?? '').trim().slice(0, APPROVAL_LIMITS.note);
    const plan = planDecision(before, userId, body.action, note, new Date());

    // Atomic: the filter re-asserts "still pending, still on this level, every slot of the level
    // exactly as I read it", so two taps, two devices, or two approvers of one level deciding at
    // the same moment can never double-decide a slot, jump the chain, or leave a level half-closed.
    const after = (await ApprovalModel()
      .findOneAndUpdate({ _id: before._id, status: 'pending', currentLevel: plan.levelIndex, ...plan.assert }, { $set: plan.set }, { returnDocument: 'after' })
      .lean()) as ApprovalDoc | null;
    if (!after) throw new AppError(409, 'This request was just updated by someone else — refresh and try again', 'STALE');

    void this.announceDecision(after, userId, plan, note);
    return presentOne(after, userId);
  },

  async announceDecision(doc: ApprovalDoc, deciderId: string, plan: DecisionPlan, note: string): Promise<void> {
    try {
      const id = String(doc._id);
      const next = plan.nextApproverIds;
      emitToUsers(audienceOf(doc).filter((u) => !next.includes(u)), 'approval:update', { id });
      const people = await resolvePeople([deciderId, doc.requesterId, ...next, ...plan.waitingOnIds]);
      const who = (uid: string): string => people.get(uid)?.name ?? 'Someone';
      const names = (ids: string[]): string => ids.map(who).join(', ');
      const levelNo = plan.levelIndex + 1;
      const total = doc.levels.length;
      if (next.length) {
        emitToUsers(next, 'approval:new', { id });
        for (const uid of next) void approvalPush.sendYourTurn(uid, who(doc.requesterId), doc.title, id);
        void approvalPush.sendLevelProgress(doc.requesterId, who(deciderId), levelNo, total, `now with ${names(next)}`, doc.title, id);
      } else if (!plan.levelClosed) {
        void approvalPush.sendLevelProgress(doc.requesterId, who(deciderId), levelNo, total, `still waiting on ${names(plan.waitingOnIds)}`, doc.title, id);
      } else if (doc.status === 'approved') {
        void approvalPush.sendApproved(doc.requesterId, doc.title, id);
      } else if (doc.status === 'rejected') {
        void approvalPush.sendRejected(doc.requesterId, who(deciderId), doc.title, note, id);
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[approvals] announce failed:', (e as Error).message);
    }
  },

  /** PUT /approvals/:id/cancel — the requester withdraws it while it is still pending. */
  async cancel(userId: string, id: string): Promise<ApprovalDto> {
    if (!Types.ObjectId.isValid(id)) throw NotFound('No such request');
    const before = (await ApprovalModel().findOne({ _id: new Types.ObjectId(id), requesterId: userId }).lean()) as ApprovalDoc | null;
    if (!before) throw NotFound('No such request');
    const set = planCancel(before, new Date());
    const after = (await ApprovalModel().findOneAndUpdate({ _id: before._id, status: 'pending' }, { $set: set }, { returnDocument: 'after' }).lean()) as ApprovalDoc | null;
    if (!after) throw new AppError(409, 'This request was just decided — refresh to see the result', 'STALE');
    // `before` still carries who had it on their desk — they drop it from their Pending list.
    emitToUsers(audienceOf(before), 'approval:update', { id });
    return presentOne(after, userId);
  },
};
