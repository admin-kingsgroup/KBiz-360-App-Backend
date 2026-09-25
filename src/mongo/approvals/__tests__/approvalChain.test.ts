import {
  hasReached,
  hierarchyFor,
  inferCategory,
  isTurnOf,
  levelsFromLegacySteps,
  pendingApproverIds,
  planCancel,
  planChain,
  planDecision,
  planLevels,
  type ChainPerson,
  type ChainState,
} from '../approval.chain';
import { approvalCreateSchema, approvalDecisionSchema, approvalListQuery, approverSearchQuery } from '../approvals.router';

// The pure chain rules: how the requester's levels become a chain, what one approve / reject
// does — "first it comes to level one, after their approval it goes to level two" — and the fixed
// role hierarchy the previous app build still sends.

const person = (id: string, level: number, branchIds: string[] = [], isSuper = level === 1): ChainPerson => ({ id, level, isSuper, branchIds });

const EMP = person('emp', 5, ['BOM']);
const POOL: ChainPerson[] = [
  person('bm-bom', 3, ['BOM', 'AMD']),
  person('bm-nbo', 3, ['NBO']),
  person('cm-1', 2),
  person('cm-2', 2),
  person('owner-1', 1),
  person('owner-2', 1),
  person('emp-2', 5, ['BOM']),
  EMP,
];
const POOL_IDS = new Set(POOL.filter((p) => p.id !== 'emp').map((p) => p.id));

describe('hierarchyFor (the role-based suggestion / legacy form)', () => {
  it('an employee gets all three steps, in review order, with their OWN branch manager only', () => {
    const h = hierarchyFor(EMP, POOL);
    expect(h.map((s) => s.def.key)).toEqual(['branch_manager', 'company_manager', 'business_owner']);
    expect(h[0].candidateIds).toEqual(['bm-bom']);
    expect(h[1].candidateIds).toEqual(['cm-1', 'cm-2']);
    expect(h[2].candidateIds).toEqual(['owner-1', 'owner-2']);
  });

  it('only steps that outrank the requester apply', () => {
    expect(hierarchyFor(person('bm-bom', 3, ['BOM']), POOL).map((s) => s.def.key)).toEqual(['company_manager', 'business_owner']);
    expect(hierarchyFor(person('cm-1', 2), POOL).map((s) => s.def.key)).toEqual(['business_owner']);
  });

  it('a business owner asks a fellow owner — never themselves', () => {
    const h = hierarchyFor(person('owner-1', 1), POOL);
    expect(h.map((s) => s.def.key)).toEqual(['business_owner']);
    expect(h[0].candidateIds).toEqual(['owner-2']);
    expect(hierarchyFor(person('owner-1', 1), POOL.filter((p) => p.id !== 'owner-2'))).toEqual([]);
  });

  it("a '*'-permission user counts as an owner whatever their level says", () => {
    const h = hierarchyFor(EMP, [person('star', 4, [], true)]);
    expect(h.map((s) => s.def.key)).toEqual(['business_owner']);
  });

  it('a step nobody can fill is dropped, not left as a dead end', () => {
    const h = hierarchyFor(person('kgd-emp', 5, ['KGD']), POOL);
    expect(h.map((s) => s.def.key)).toEqual(['company_manager', 'business_owner']);
  });
});

describe('planLevels (the requester builds the chain)', () => {
  it('any number of levels, one or more people each: level 1 pending, the rest waiting; label + mode default', () => {
    const levels = planLevels('emp', POOL_IDS, [
      { label: '  Managers ', mode: 'all', approverIds: ['bm-bom', 'cm-1'] },
      { mode: 'any', approverIds: ['owner-1', 'owner-2'] },
      { approverIds: ['emp-2'] },
    ]);
    expect(levels.map((l) => [l.order, l.label, l.mode, l.status, l.approvers.map((a) => [a.userId, a.status])])).toEqual([
      [1, 'Managers', 'all', 'pending', [['bm-bom', 'pending'], ['cm-1', 'pending']]],
      [2, 'Level 2', 'any', 'waiting', [['owner-1', 'waiting'], ['owner-2', 'waiting']]],
      [3, 'Level 3', 'all', 'waiting', [['emp-2', 'waiting']]],
    ]);
    expect(levels[0].key).toBeNull();
    expect(levels[0].approvers[0]).toMatchObject({ decidedAt: null, note: '' });
  });

  it('refuses no levels, an empty level, yourself, the same person on two levels, a stranger, a bad mode, too many', () => {
    expect(() => planLevels('emp', POOL_IDS, [])).toThrow(/at least one approval level/);
    expect(() => planLevels('emp', POOL_IDS, [{ approverIds: [] }])).toThrow(/Level 1 has no approver/);
    expect(() => planLevels('emp', POOL_IDS, [{ approverIds: ['emp'] }])).toThrow(/your own request/);
    expect(() => planLevels('emp', POOL_IDS, [{ approverIds: ['cm-1'] }, { label: 'Finance', approverIds: ['cm-1'] }])).toThrow(/Finance: that person is already on an earlier level/);
    expect(() => planLevels('emp', POOL_IDS, [{ approverIds: ['ghost'] }])).toThrow(/cannot approve on the app/);
    expect(() => planLevels('emp', POOL_IDS, [{ mode: 'majority', approverIds: ['cm-1'] }])).toThrow(/mode must be "all" or "any"/);
    expect(() => planLevels('emp', POOL_IDS, Array.from({ length: 11 }, () => ({ approverIds: ['cm-1'] })))).toThrow(/at most 10 levels/);
    expect(() => planLevels('emp', POOL_IDS, [{ approverIds: Array.from({ length: 11 }, (_v, i) => `p${i}`) }])).toThrow(/at most 10 approvers/);
  });

  it('the same id sent twice on ONE level is collapsed, not refused', () => {
    expect(planLevels('emp', POOL_IDS, [{ approverIds: ['cm-1', 'cm-1'] }])[0].approvers).toHaveLength(1);
  });
});

describe('planChain (legacy role picks → single-person levels)', () => {
  const h = hierarchyFor(EMP, POOL);
  const picks = [
    { step: 'business_owner', userId: 'owner-2' },
    { step: 'branch_manager', userId: 'bm-bom' },
    { step: 'company_manager', userId: 'cm-1' },
  ];

  it('stores the chain in HIERARCHY order (not pick order), one person per level, only level 1 pending', () => {
    const levels = planChain(h, picks);
    expect(levels.map((l) => [l.order, l.key, l.label, l.mode, l.status, l.approvers.map((a) => a.userId)])).toEqual([
      [1, 'branch_manager', 'Branch manager', 'all', 'pending', ['bm-bom']],
      [2, 'company_manager', 'Company manager', 'all', 'waiting', ['cm-1']],
      [3, 'business_owner', 'Business owner', 'all', 'waiting', ['owner-2']],
    ]);
  });

  it('refuses a missing step, a stray step, a duplicate and an outsider', () => {
    expect(() => planChain(h, picks.slice(0, 2))).toThrow(/Select an approver for: Company manager/);
    expect(() => planChain(h, [...picks, { step: 'hod', userId: 'x' }])).toThrow(/Not a step/);
    expect(() => planChain(h, [...picks, picks[0]])).toThrow(/sent twice/);
    expect(() => planChain(h, [picks[0], picks[2], { step: 'branch_manager', userId: 'bm-nbo' }])).toThrow(/cannot approve as Branch manager/);
    expect(() => planChain(h, [picks[0], picks[2], { step: 'branch_manager', userId: 'emp' }])).toThrow(/cannot approve/);
  });

  it('nobody above you → 422 NO_APPROVERS', () => {
    expect(() => planChain([], [])).toThrow(/nobody above you/);
  });
});

describe('levelsFromLegacySteps (boot migration)', () => {
  it('one step → one single-approver level with the same status, note and key', () => {
    const at = new Date('2026-09-19T05:00:00Z');
    const levels = levelsFromLegacySteps([
      { key: 'branch_manager', label: 'Branch manager', approverId: 'bm', status: 'approved', decidedAt: at, note: 'ok' },
      { key: 'company_manager', label: 'Company manager', approverId: 'cm', status: 'pending', decidedAt: null, note: '' },
      { key: 'business_owner', label: 'Business owner', approverId: 'own', status: 'waiting', decidedAt: null, note: '' },
    ]);
    expect(levels).toEqual([
      { order: 1, key: 'branch_manager', label: 'Branch manager', mode: 'all', status: 'approved', decidedAt: at, approvers: [{ userId: 'bm', status: 'approved', decidedAt: at, note: 'ok' }] },
      { order: 2, key: 'company_manager', label: 'Company manager', mode: 'all', status: 'pending', decidedAt: null, approvers: [{ userId: 'cm', status: 'pending', decidedAt: null, note: '' }] },
      { order: 3, key: 'business_owner', label: 'Business owner', mode: 'all', status: 'waiting', decidedAt: null, approvers: [{ userId: 'own', status: 'waiting', decidedAt: null, note: '' }] },
    ]);
  });
});

describe('planDecision', () => {
  const NOW = new Date('2026-09-25T06:00:00Z');
  type Slot = ChainState['levels'][number]['approvers'][number];
  // Level 1: BOTH managers · Level 2: EITHER owner · Level 3: finance
  const fresh = (): ChainState => ({
    status: 'pending',
    currentLevel: 0,
    levels: [
      { mode: 'all', status: 'pending', approvers: [{ userId: 'bm', status: 'pending' }, { userId: 'cm', status: 'pending' }] },
      { mode: 'any', status: 'waiting', approvers: [{ userId: 'o1', status: 'waiting' }, { userId: 'o2', status: 'waiting' }] },
      { mode: 'all', status: 'waiting', approvers: [{ userId: 'fin', status: 'waiting' }] },
    ],
  });
  // Apply a plan's $set the way Mongo would, so a whole chain can be walked in memory.
  const apply = (doc: ChainState, set: Record<string, unknown>): ChainState => {
    const next: ChainState = { ...doc, levels: doc.levels.map((l) => ({ ...l, approvers: l.approvers.map((a) => ({ ...a })) })) };
    for (const [k, v] of Object.entries(set)) {
      const slot = /^levels\.(\d+)\.approvers\.(\d+)\.status$/.exec(k);
      const lvl = /^levels\.(\d+)\.status$/.exec(k);
      if (slot) next.levels[Number(slot[1])].approvers[Number(slot[2])].status = v as Slot['status'];
      else if (lvl) next.levels[Number(lvl[1])].status = v as Slot['status'];
      else if (k === 'status') next.status = v as ChainState['status'];
      else if (k === 'currentLevel') next.currentLevel = v as number;
    }
    return next;
  };
  const statuses = (doc: ChainState): string[][] => doc.levels.map((l) => [l.status, ...l.approvers.map((a) => a.status)]);

  it('mode "all": the level closes only when EVERYONE on it approved; "any": at the first approval', () => {
    let doc = fresh();
    const p1 = planDecision(doc, 'bm', 'approve', 'fine', NOW);
    expect(p1).toMatchObject({ levelIndex: 0, approverIndex: 0, status: 'pending', levelClosed: false, nextApproverIds: [], waitingOnIds: ['cm'] });
    expect(p1.set['levels.0.approvers.0.note']).toBe('fine');
    doc = apply(doc, p1.set);
    expect(doc.currentLevel).toBe(0);
    expect(statuses(doc)).toEqual([['pending', 'approved', 'pending'], ['waiting', 'waiting', 'waiting'], ['waiting', 'waiting']]);
    expect(pendingApproverIds(doc)).toEqual(['cm']);
    expect(hasReached(doc, 'o1')).toBe(false);

    const p2 = planDecision(doc, 'cm', 'approve', '', NOW);
    expect(p2).toMatchObject({ status: 'pending', levelClosed: true, nextApproverIds: ['o1', 'o2'], waitingOnIds: [] });
    expect(p2.set['levels.0.decidedAt']).toBe(NOW);
    doc = apply(doc, p2.set);
    expect(doc.currentLevel).toBe(1);
    expect(statuses(doc)).toEqual([['approved', 'approved', 'approved'], ['pending', 'pending', 'pending'], ['waiting', 'waiting']]);
    expect(pendingApproverIds(doc)).toEqual(['o1', 'o2']);
    expect(isTurnOf(doc, 'o2')).toBe(true);

    // either owner — the other is skipped, but keeps seeing it (the level was theirs)
    const p3 = planDecision(doc, 'o2', 'approve', '', NOW);
    expect(p3).toMatchObject({ levelClosed: true, nextApproverIds: ['fin'] });
    doc = apply(doc, p3.set);
    expect(statuses(doc)[1]).toEqual(['approved', 'skipped', 'approved']);
    expect(hasReached(doc, 'o1')).toBe(true);
    expect(isTurnOf(doc, 'o1')).toBe(false);
    expect(() => planDecision(doc, 'o1', 'approve', '', NOW)).toThrow(/already been decided/);

    const p4 = planDecision(doc, 'fin', 'approve', '', NOW);
    expect(p4).toMatchObject({ status: 'approved', levelClosed: true, nextApproverIds: [] });
    expect(p4.set.decidedAt).toBe(NOW);
    doc = apply(doc, p4.set);
    expect(doc).toMatchObject({ status: 'approved', currentLevel: 3 });
    expect(statuses(doc).map((l) => l[0])).toEqual(['approved', 'approved', 'approved']);
    expect(pendingApproverIds(doc)).toEqual([]);
  });

  it('a single-person level moves on at once (the legacy chain)', () => {
    const doc: ChainState = { status: 'pending', currentLevel: 0, levels: [{ mode: 'all', status: 'pending', approvers: [{ userId: 'bm', status: 'pending' }] }, { mode: 'all', status: 'waiting', approvers: [{ userId: 'cm', status: 'waiting' }] }] };
    expect(planDecision(doc, 'bm', 'approve', '', NOW)).toMatchObject({ levelClosed: true, nextApproverIds: ['cm'], set: { currentLevel: 1, 'levels.1.status': 'pending', 'levels.1.approvers.0.status': 'pending' } });
  });

  it('nobody jumps the queue, decides twice, or decides from outside the chain', () => {
    expect(() => planDecision(fresh(), 'o1', 'approve', '', NOW)).toThrow(/not your turn/);
    expect(() => planDecision(fresh(), 'fin', 'reject', '', NOW)).toThrow(/not your turn/);
    expect(() => planDecision(fresh(), 'emp', 'approve', '', NOW)).toThrow(/not an approver/);
    const afterOne = apply(fresh(), planDecision(fresh(), 'bm', 'approve', '', NOW).set);
    expect(() => planDecision(afterOne, 'bm', 'approve', '', NOW)).toThrow(/already decided on this request/);
  });

  it('the atomic write re-asserts every slot of the level as read (two "all" approvers at once)', () => {
    const p = planDecision(fresh(), 'cm', 'approve', '', NOW);
    expect(p.assert).toEqual({ 'levels.0.approvers.1.userId': 'cm', 'levels.0.approvers.0.status': 'pending', 'levels.0.approvers.1.status': 'pending' });
    // once bm has approved, a plan built from the OLD read no longer matches the document
    const moved = apply(fresh(), planDecision(fresh(), 'bm', 'approve', '', NOW).set);
    expect(planDecision(moved, 'cm', 'approve', '', NOW).assert['levels.0.approvers.0.status']).toBe('approved');
  });

  it('one rejection ends the chain: the rest of the level and every later level are skipped', () => {
    let doc = fresh();
    const p = planDecision(doc, 'cm', 'reject', 'over budget', NOW);
    expect(p).toMatchObject({ status: 'rejected', levelClosed: true, nextApproverIds: [], waitingOnIds: [] });
    expect(p.set['levels.0.approvers.1.note']).toBe('over budget');
    doc = apply(doc, p.set);
    expect(statuses(doc)).toEqual([['rejected', 'skipped', 'rejected'], ['skipped', 'skipped', 'skipped'], ['skipped', 'skipped']]);
    expect(hasReached(doc, 'bm')).toBe(true); // it had reached their level
    expect(hasReached(doc, 'o1')).toBe(false); // never got there
    expect(() => planDecision(doc, 'o1', 'approve', '', NOW)).toThrow(/already rejected/);
  });

  it('a request reaches an approver only when the chain gets to their level', () => {
    const doc = fresh();
    expect(hasReached(doc, 'bm')).toBe(true);
    expect(hasReached(doc, 'cm')).toBe(true);
    expect(hasReached(doc, 'o1')).toBe(false);
    expect(isTurnOf(doc, 'cm')).toBe(true);
    expect(isTurnOf(doc, 'o1')).toBe(false);
  });

  it('withdrawal skips whatever was undecided, keeps what was decided, and only works while pending', () => {
    const half = apply(fresh(), planDecision(fresh(), 'bm', 'approve', '', NOW).set);
    const cancelled = apply(half, planCancel(half, NOW));
    expect(cancelled.status).toBe('cancelled');
    expect(statuses(cancelled)).toEqual([['skipped', 'approved', 'skipped'], ['skipped', 'skipped', 'skipped'], ['skipped', 'skipped']]);
    expect(hasReached(cancelled, 'bm')).toBe(true); // they decided — they keep seeing it
    expect(hasReached(cancelled, 'cm')).toBe(false); // withdrawn before they acted — gone from their list
    expect(() => planCancel(cancelled, NOW)).toThrow(/only a pending request/);
  });
});

describe('inferCategory', () => {
  it('reads the card tag off the title when the form sent none', () => {
    expect(inferCategory('Salary release approval')).toBe('Salary');
    expect(inferCategory('Today holiday approval')).toBe('Holiday');
    expect(inferCategory('Client visit expense approval')).toBe('Expense');
    expect(inferCategory('Work from home request')).toBe('HR');
    expect(inferCategory('New laptop')).toBe('General');
  });
});

// validate() strips unknown keys — every field must be declared or it silently vanishes.
describe('router schemas', () => {
  it('create keeps the levels (label/mode optional) and trims title/details', () => {
    const parsed = approvalCreateSchema.parse({ title: '  Salary release  ', details: ' Sept payroll ', levels: [{ label: ' Managers ', mode: 'any', approverIds: ['u1', 'u2'] }, { approverIds: ['u3'] }] });
    expect(parsed).toEqual({ title: 'Salary release', details: 'Sept payroll', levels: [{ label: 'Managers', mode: 'any', approverIds: ['u1', 'u2'] }, { approverIds: ['u3'] }] });
    expect(() => approvalCreateSchema.parse({ title: ' ', details: 'x', levels: [{ approverIds: ['u1'] }] })).toThrow();
    expect(() => approvalCreateSchema.parse({ title: 'x', details: 'y', levels: [] })).toThrow();
    expect(() => approvalCreateSchema.parse({ title: 'x', details: 'y', levels: [{ approverIds: [] }] })).toThrow();
    expect(() => approvalCreateSchema.parse({ title: 'x', details: 'y', levels: [{ mode: 'majority', approverIds: ['u1'] }] })).toThrow();
    expect(() => approvalCreateSchema.parse({ title: 'x', details: 'y' })).toThrow(/at least one approval level/);
  });

  it('create still accepts the legacy role picks', () => {
    const parsed = approvalCreateSchema.parse({ title: 'x', details: 'y', approvers: [{ step: 'branch_manager', userId: 'u1' }] });
    expect(parsed).toEqual({ title: 'x', details: 'y', approvers: [{ step: 'branch_manager', userId: 'u1' }] });
    expect(() => approvalCreateSchema.parse({ title: 'x', details: 'y', approvers: [] })).toThrow();
  });

  it('decision takes approve|reject with an optional note; list + approver queries default + coerce', () => {
    expect(approvalDecisionSchema.parse({ action: 'reject', note: 'no budget' })).toEqual({ action: 'reject', note: 'no budget' });
    expect(() => approvalDecisionSchema.parse({ action: 'maybe' })).toThrow();
    expect(approvalListQuery.parse({})).toEqual({ scope: 'all', page: 1, limit: 50 });
    expect(approvalListQuery.parse({ scope: 'actionable', status: 'pending', page: '2', limit: '10' })).toEqual({ scope: 'actionable', status: 'pending', page: 2, limit: 10 });
    expect(() => approvalListQuery.parse({ limit: '500' })).toThrow();
    expect(approverSearchQuery.parse({})).toEqual({ limit: 200 });
    expect(approverSearchQuery.parse({ q: ' faiz ', limit: '5' })).toEqual({ q: 'faiz', limit: 5 });
  });
});
