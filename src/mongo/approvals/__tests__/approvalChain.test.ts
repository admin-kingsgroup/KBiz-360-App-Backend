import {
  hasReached,
  hierarchyFor,
  inferCategory,
  isTurnOf,
  planCancel,
  planChain,
  planDecision,
  type ChainPerson,
  type ChainState,
} from '../approval.chain';
import { approvalCreateSchema, approvalDecisionSchema, approvalListQuery } from '../approvals.router';

// The pure chain rules: who a requester's form offers, how picks become a chain, and what one
// approve / reject does — "first it comes to level one, after their approval it goes to level two".

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

describe('hierarchyFor', () => {
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

describe('planChain', () => {
  const h = hierarchyFor(EMP, POOL);
  const picks = [
    { step: 'business_owner', userId: 'owner-2' },
    { step: 'branch_manager', userId: 'bm-bom' },
    { step: 'company_manager', userId: 'cm-1' },
  ];

  it('stores the chain in HIERARCHY order (not pick order) with only step 1 pending', () => {
    const steps = planChain(h, picks);
    expect(steps.map((s) => [s.key, s.approverId, s.status])).toEqual([
      ['branch_manager', 'bm-bom', 'pending'],
      ['company_manager', 'cm-1', 'waiting'],
      ['business_owner', 'owner-2', 'waiting'],
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

describe('planDecision', () => {
  const NOW = new Date('2026-09-18T06:00:00Z');
  const fresh = (): ChainState => ({
    status: 'pending',
    currentStep: 0,
    steps: [
      { approverId: 'bm-bom', status: 'pending' },
      { approverId: 'cm-1', status: 'waiting' },
      { approverId: 'owner-2', status: 'waiting' },
    ],
  });
  // Apply a plan's $set the way Mongo would, so a whole chain can be walked in memory.
  const apply = (doc: ChainState, set: Record<string, unknown>): ChainState => {
    const next: ChainState = { ...doc, steps: doc.steps.map((s) => ({ ...s })) };
    for (const [k, v] of Object.entries(set)) {
      const m = /^steps\.(\d+)\.status$/.exec(k);
      if (m) next.steps[Number(m[1])].status = v as ChainState['steps'][number]['status'];
      else if (k === 'status') next.status = v as ChainState['status'];
      else if (k === 'currentStep') next.currentStep = v as number;
    }
    return next;
  };

  it('walks level 1 → 2 → 3 and only then is approved', () => {
    let doc = fresh();
    const p1 = planDecision(doc, 'bm-bom', 'approve', '', NOW);
    expect(p1).toMatchObject({ stepIndex: 0, status: 'pending', nextApproverId: 'cm-1' });
    doc = apply(doc, p1.set);
    expect(doc.steps.map((s) => s.status)).toEqual(['approved', 'pending', 'waiting']);

    const p2 = planDecision(doc, 'cm-1', 'approve', 'ok', NOW);
    expect(p2).toMatchObject({ stepIndex: 1, status: 'pending', nextApproverId: 'owner-2' });
    doc = apply(doc, p2.set);

    const p3 = planDecision(doc, 'owner-2', 'approve', '', NOW);
    expect(p3).toMatchObject({ stepIndex: 2, status: 'approved', nextApproverId: null });
    doc = apply(doc, p3.set);
    expect(doc).toMatchObject({ status: 'approved', currentStep: 3 });
    expect(doc.steps.map((s) => s.status)).toEqual(['approved', 'approved', 'approved']);
    expect(p3.set.decidedAt).toBe(NOW);
  });

  it('nobody jumps the queue, decides twice, or decides from outside the chain', () => {
    expect(() => planDecision(fresh(), 'cm-1', 'approve', '', NOW)).toThrow(/not your turn/);
    expect(() => planDecision(fresh(), 'owner-2', 'reject', '', NOW)).toThrow(/not your turn/);
    expect(() => planDecision(fresh(), 'emp', 'approve', '', NOW)).toThrow(/not an approver/);
    const afterOne = apply(fresh(), planDecision(fresh(), 'bm-bom', 'approve', '', NOW).set);
    expect(() => planDecision(afterOne, 'bm-bom', 'approve', '', NOW)).toThrow(/already decided/);
  });

  it('one rejection ends the chain and skips every later step', () => {
    let doc = apply(fresh(), planDecision(fresh(), 'bm-bom', 'approve', '', NOW).set);
    const p = planDecision(doc, 'cm-1', 'reject', 'over budget', NOW);
    expect(p).toMatchObject({ status: 'rejected', nextApproverId: null });
    expect(p.set['steps.1.note']).toBe('over budget');
    doc = apply(doc, p.set);
    expect(doc.steps.map((s) => s.status)).toEqual(['approved', 'rejected', 'skipped']);
    expect(() => planDecision(doc, 'owner-2', 'approve', '', NOW)).toThrow(/already rejected/);
  });

  it('a request reaches an approver only when the chain gets to them', () => {
    const doc = fresh();
    expect(hasReached(doc, 'bm-bom')).toBe(true);
    expect(hasReached(doc, 'cm-1')).toBe(false);
    expect(isTurnOf(doc, 'bm-bom')).toBe(true);
    expect(isTurnOf(doc, 'cm-1')).toBe(false);
    const moved = apply(doc, planDecision(doc, 'bm-bom', 'approve', '', NOW).set);
    expect(hasReached(moved, 'cm-1')).toBe(true);
    expect(isTurnOf(moved, 'cm-1')).toBe(true);
    expect(isTurnOf(moved, 'bm-bom')).toBe(false);
    expect(hasReached(moved, 'bm-bom')).toBe(true); // keeps seeing what they decided
    // rejected at step 1 → steps 2 and 3 never see it
    const dead = apply(doc, planDecision(doc, 'bm-bom', 'reject', '', NOW).set);
    expect(hasReached(dead, 'cm-1')).toBe(false);
    expect(hasReached(dead, 'owner-2')).toBe(false);
  });

  it('withdrawal skips whatever was undecided and only works while pending', () => {
    const moved = apply(fresh(), planDecision(fresh(), 'bm-bom', 'approve', '', NOW).set);
    const cancelled = apply(moved, planCancel(moved, NOW));
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.steps.map((s) => s.status)).toEqual(['approved', 'skipped', 'skipped']);
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
  it('create keeps the approver picks and trims title/details', () => {
    const parsed = approvalCreateSchema.parse({ title: '  Salary release  ', details: ' Sept payroll ', approvers: [{ step: 'branch_manager', userId: 'u1' }] });
    expect(parsed).toEqual({ title: 'Salary release', details: 'Sept payroll', approvers: [{ step: 'branch_manager', userId: 'u1' }] });
    expect(() => approvalCreateSchema.parse({ title: ' ', details: 'x', approvers: [{ step: 'a', userId: 'b' }] })).toThrow();
    expect(() => approvalCreateSchema.parse({ title: 'x', details: 'y', approvers: [] })).toThrow();
  });

  it('decision takes approve|reject with an optional note; list query defaults + coerces', () => {
    expect(approvalDecisionSchema.parse({ action: 'reject', note: 'no budget' })).toEqual({ action: 'reject', note: 'no budget' });
    expect(() => approvalDecisionSchema.parse({ action: 'maybe' })).toThrow();
    expect(approvalListQuery.parse({})).toEqual({ scope: 'all', page: 1, limit: 50 });
    expect(approvalListQuery.parse({ scope: 'actionable', status: 'pending', page: '2', limit: '10' })).toEqual({ scope: 'actionable', status: 'pending', page: 2, limit: 10 });
    expect(() => approvalListQuery.parse({ limit: '500' })).toThrow();
  });
});
