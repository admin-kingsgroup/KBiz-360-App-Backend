import { Types } from 'mongoose';
import { AppError, BadRequest, Forbidden, NotFound } from '../../common/errors';
import { crmRepo, type CrmRole, type CrmUser } from '../crm.repo';
import { accessService, deriveAccess } from '../access';
import { appAccess } from '../appAccess';
import { userAvatars } from '../userAvatars';
import { userPositions } from '../userPositions';
import { emitToUser, emitToUsers } from '../chat/chat.events';
import { ApprovalModel, type ApprovalDoc, type ApprovalStatus } from './approval.model';
import { approvalPush } from './approval.push';
import {
  APPROVAL_CATEGORIES,
  APPROVAL_LIMITS,
  hasReached,
  hierarchyFor,
  inferCategory,
  isTurnOf,
  planCancel,
  planChain,
  planDecision,
  type ApproverPick,
  type ChainPerson,
  type HierarchyStep,
} from './approval.chain';

// Approval requests with a CHAIN of approvers: request → step 1 → step 2 → … → approved, one
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

export interface ApprovalStepDto {
  order: number; // 1-based
  key: string;
  label: string;
  approver: PersonDto;
  status: string; // waiting | pending | approved | rejected | skipped
  isCurrent: boolean; // the step the request is sitting on right now
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
  totalSteps: number;
  currentStep: number | null; // 1-based order of the step awaiting a decision; null once final
  currentApprover: PersonDto | null;
  steps: ApprovalStepDto[];
  // ── relative to the caller ──
  isMine: boolean; // the caller raised it
  canAct: boolean; // it is the caller's turn → show Approve / Reject
  canCancel: boolean; // the caller may withdraw it
  myDecision: 'approved' | 'rejected' | null; // what the caller decided on their own step
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

function present(doc: ApprovalDoc, people: Map<string, PersonDto>, viewerId: string): ApprovalDto {
  const person = (id: string): PersonDto => people.get(id) ?? unknownPerson(id);
  const pending = doc.status === 'pending';
  const current = pending ? doc.steps[doc.currentStep] : undefined;
  const mine = doc.steps.find((s) => s.approverId === viewerId);
  return {
    id: String(doc._id),
    title: doc.title,
    details: doc.details,
    category: doc.category,
    status: doc.status,
    submittedAt: (doc.submittedAt ?? doc.createdAt).toISOString(),
    decidedAt: doc.decidedAt ? doc.decidedAt.toISOString() : null,
    requester: person(doc.requesterId),
    totalSteps: doc.steps.length,
    currentStep: current ? doc.currentStep + 1 : null,
    currentApprover: current ? person(current.approverId) : null,
    steps: doc.steps.map((s, i) => ({
      order: i + 1,
      key: s.key,
      label: s.label,
      approver: person(s.approverId),
      status: s.status,
      isCurrent: pending && i === doc.currentStep,
      decidedAt: s.decidedAt ? s.decidedAt.toISOString() : null,
      note: s.note ?? '',
    })),
    isMine: doc.requesterId === viewerId,
    canAct: isTurnOf(doc, viewerId),
    canCancel: pending && doc.requesterId === viewerId,
    myDecision: mine && (mine.status === 'approved' || mine.status === 'rejected') ? mine.status : null,
  };
}

async function presentMany(docs: ApprovalDoc[], viewerId: string): Promise<ApprovalDto[]> {
  const people = await resolvePeople(docs.flatMap((d) => [d.requesterId, ...d.steps.map((s) => s.approverId)]));
  return docs.map((d) => present(d, people, viewerId));
}
const presentOne = async (doc: ApprovalDoc, viewerId: string): Promise<ApprovalDto> => (await presentMany([doc], viewerId))[0];

// The pool = people who can actually ACT on a request: active, App Access on in the ERP, not
// switched off in the app, same tenant. An approver who cannot open the app would strand the chain.
// Tenant rule = the one every admin read here uses: only a PRESENT-and-different tenant excludes
// (several live users, super admins among them, carry no tenant_id at all).
// Branch overlap counts LIVE branches only — users still hold ids of branch rows that were
// retired from the CRM, and sharing a dead id must not make a stranger "your" branch manager.
async function hierarchyOf(userId: string): Promise<HierarchyStep[]> {
  const me = await crmRepo.getUserById(userId);
  if (!me) throw Forbidden('Session user not found');
  const [users, roles, branches, disabled] = await Promise.all([
    crmRepo.listUsers({ status: 'active' }),
    crmRepo.listRoles(),
    crmRepo.listBranches(),
    appAccess.disabledSet(),
  ]);
  const roleById = new Map<string, CrmRole>(roles.map((r) => [String(r._id), r]));
  const liveBranches = new Set(branches.map((b) => String(b._id)));
  const toChainPerson = (u: CrmUser): ChainPerson => {
    const a = deriveAccess(u, u.role_id ? roleById.get(String(u.role_id)) ?? null : null);
    return { id: a.userId, level: a.level, isSuper: a.isSuper, branchIds: (u.branch_ids ?? []).map(String).filter((b) => liveBranches.has(b)) };
  };
  const sameTenant = (u: CrmUser): boolean => !(me.tenant_id && u.tenant_id && String(u.tenant_id) !== String(me.tenant_id));
  const pool = users.filter((u) => u.access?.app === true && !disabled.has(String(u._id)) && sameTenant(u)).map(toChainPerson);
  return hierarchyFor(toChainPerson(me), pool);
}

// What a viewer may see: their own requests + the ones the chain has brought to them.
const reachedMe = (me: string): Record<string, unknown> => ({ steps: { $elemMatch: { approverId: me, status: { $in: ['pending', 'approved', 'rejected'] } } } });
const myTurn = (me: string): Record<string, unknown> => ({ status: 'pending', steps: { $elemMatch: { approverId: me, status: 'pending' } } });

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

// Everyone the request has touched so far (requester + reached approvers) — they get the
// bare-id `approval:update` signal and refetch through the access-filtered REST reads.
const audienceOf = (doc: ApprovalDoc): string[] => [
  ...new Set([doc.requesterId, ...doc.steps.filter((s) => s.status !== 'waiting' && s.status !== 'skipped').map((s) => s.approverId)]),
];

export const approvalService = {
  /** GET /approvals/hierarchy — what the New request form renders: the caller's steps, in review
   *  order, each with the people who may be picked for it. */
  async hierarchy(userId: string) {
    const steps = await hierarchyOf(userId);
    const people = await resolvePeople(steps.flatMap((s) => s.candidateIds));
    return {
      totalSteps: steps.length,
      steps: steps.map((s, i) => {
        const candidates = s.candidateIds.map((id) => people.get(id) ?? unknownPerson(id)).sort((a, b) => a.name.localeCompare(b.name));
        return {
          order: i + 1,
          key: s.def.key,
          label: s.def.label,
          placeholder: `Select ${s.def.label.toLowerCase()}`,
          required: true,
          // One possible approver → the form can pre-select them.
          defaultApproverId: candidates.length === 1 ? candidates[0].id : null,
          candidates,
        };
      }),
      categories: APPROVAL_CATEGORIES,
      limits: APPROVAL_LIMITS,
    };
  },

  /** POST /approvals — raise a request. The chain is rebuilt server-side from the caller's own
   *  hierarchy, so a pick outside it (wrong role, other branch, yourself) is refused. */
  async create(userId: string, body: { title: string; details: string; category?: string; approvers: ApproverPick[] }): Promise<ApprovalDto> {
    const title = body.title.trim();
    const details = body.details.trim();
    if (!title) throw BadRequest('Give the request a title');
    if (!details) throw BadRequest('Explain what needs approval');
    const me = await crmRepo.getUserById(userId);
    if (!me) throw Forbidden('Session user not found');
    const steps = planChain(await hierarchyOf(userId), body.approvers);
    const category = (body.category ?? '').trim() || inferCategory(title);

    const doc = await ApprovalModel().create({
      tenantId: me.tenant_id ? String(me.tenant_id) : null,
      requesterId: userId,
      title,
      details,
      category,
      status: 'pending',
      currentStep: 0,
      steps,
      submittedAt: new Date(),
    });
    const saved = doc.toObject() as ApprovalDoc;
    const id = String(saved._id);

    // It comes to step 1 only — later approvers hear nothing until it reaches them.
    emitToUser(steps[0].approverId, 'approval:new', { id });
    void approvalPush.sendYourTurn(steps[0].approverId, nameOf(me), title, id);

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

  /** GET /approvals/:id — the requester, an approver the chain has reached, or a super admin of
   *  the same tenant. Anyone else gets 404, not 403 — a later step must not learn it exists. */
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

  /** PUT /approvals/:id/decision { action, note? } — approve hands it to the next step (or
   *  finishes it); reject ends it. Only the approver whose TURN it is may decide. */
  async decide(userId: string, id: string, body: { action: 'approve' | 'reject'; note?: string }): Promise<ApprovalDto> {
    if (!Types.ObjectId.isValid(id)) throw NotFound('No such request');
    const before = (await ApprovalModel().findById(id).lean()) as ApprovalDoc | null;
    // A stranger learns nothing, not even that it exists; someone ON the chain gets the precise
    // refusal from planDecision (NOT_YOUR_TURN / ALREADY_DECIDED / NOT_PENDING).
    if (!before || !before.steps.some((s) => s.approverId === userId)) throw NotFound('No such request');
    const note = String(body.note ?? '').trim().slice(0, APPROVAL_LIMITS.note);
    const plan = planDecision(before, userId, body.action, note, new Date());

    // Atomic: the filter re-asserts "still pending, still on my step", so two taps (or two
    // devices) can never decide one step twice or jump the chain.
    const after = (await ApprovalModel()
      .findOneAndUpdate(
        { _id: before._id, status: 'pending', currentStep: plan.stepIndex, [`steps.${plan.stepIndex}.approverId`]: userId, [`steps.${plan.stepIndex}.status`]: 'pending' },
        { $set: plan.set },
        { returnDocument: 'after' },
      )
      .lean()) as ApprovalDoc | null;
    if (!after) throw new AppError(409, 'This request was just updated by someone else — refresh and try again', 'STALE');

    void this.announceDecision(after, userId, plan.stepIndex, plan.nextApproverId, note);
    return presentOne(after, userId);
  },

  async announceDecision(doc: ApprovalDoc, deciderId: string, stepIndex: number, nextApproverId: string | null, note: string): Promise<void> {
    try {
      const id = String(doc._id);
      emitToUsers(audienceOf(doc).filter((u) => u !== nextApproverId), 'approval:update', { id });
      const people = await resolvePeople([deciderId, doc.requesterId, ...(nextApproverId ? [nextApproverId] : [])]);
      const who = (uid: string): string => people.get(uid)?.name ?? 'Someone';
      if (nextApproverId) {
        emitToUser(nextApproverId, 'approval:new', { id });
        void approvalPush.sendYourTurn(nextApproverId, who(doc.requesterId), doc.title, id);
        void approvalPush.sendStepApproved(doc.requesterId, who(deciderId), stepIndex + 1, doc.steps.length, who(nextApproverId), doc.title, id);
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
