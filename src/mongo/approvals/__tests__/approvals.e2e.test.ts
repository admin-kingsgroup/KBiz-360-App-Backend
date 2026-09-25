/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-var-requires */
import request from 'supertest';
import { Types } from 'mongoose';

// END-TO-END chain test over real HTTP + a real Mongo — but ONLY a throwaway LOCAL one:
//   APPROVALS_E2E_MONGO_URI=mongodb://127.0.0.1:27017 npx jest src/mongo/approvals
// Self-skips when the variable is unset, refuses any non-local host, and works in (then drops)
// its own kb360_e2e_* databases — it can never touch Atlas, the CRM or kb360_app.
const URI = process.env.APPROVALS_E2E_MONGO_URI ?? '';
const LOCAL = /^mongodb:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/?$/.test(URI);
const CRM_DB = `kb360_e2e_crm_${process.pid}`;
const APP_DB = `kb360_e2e_app_${process.pid}`;

let app: any;
let mongo: any;
let ready = false;
const tokens: Record<string, string> = {};
const ids: Record<string, string> = {};
const as = (who: string) => ({ Authorization: `Bearer ${tokens[who]}` });

beforeAll(async () => {
  if (!URI) return;
  if (!LOCAL) throw new Error('APPROVALS_E2E_MONGO_URI must be a LOCAL mongod (mongodb://127.0.0.1:27017) — refusing to run');
  // config reads the environment at import time (dotenv never overrides), so set it first and
  // only THEN load the app.
  process.env.MONGODB_URI = URI;
  process.env.CRM_DB = CRM_DB;
  process.env.APP_DB = APP_DB;
  process.env.CRM_WRITE_MONGODB_URI = '';
  process.env.EXPO_PUSH_ENABLED = 'false';
  mongo = require('../../connection');
  await mongo.connectMongo();
  if (mongo.crmDb().name !== CRM_DB || mongo.appDb().name !== APP_DB) throw new Error('e2e databases not selected — refusing to seed');

  const crm = mongo.crmDb().db; // native Db handle of the throwaway CRM
  const tenant = new Types.ObjectId();
  const role = (name: string, level: number) => ({ _id: new Types.ObjectId(), tenant_id: tenant, name, level, permissions: level === 1 ? ['*'] : [] });
  const roles = { owner: role('super_admin', 1), cm: role('company_manager', 2), bm: role('branch_manager', 3), emp: role('employee', 5) };
  const BOM = new Types.ObjectId();
  const NBO = new Types.ObjectId();
  const DEAD = new Types.ObjectId(); // a retired branch row both emp and bmNbo still carry
  await crm.collection('roles').insertMany(Object.values(roles));
  await crm.collection('branches').insertMany([{ _id: BOM, tenant_id: tenant, code: 'BOM' }, { _id: NBO, tenant_id: tenant, code: 'NBO' }]);
  const user = (key: string, first: string, last: string, r: { _id: Types.ObjectId }, branches: Types.ObjectId[], appOn = true) => {
    const _id = new Types.ObjectId();
    ids[key] = String(_id);
    return { _id, tenant_id: tenant, role_id: r._id, email: `${key}@e2e.test`, first_name: first, last_name: last, status: 'active', branch_ids: branches, access: { app: appOn } };
  };
  await crm.collection('users').insertMany([
    user('emp', 'Rohan', 'Mehta', roles.emp, [BOM, DEAD]),
    user('outsider', 'Nandni', 'Shah', roles.emp, [BOM]),
    user('fin', 'Kiran', 'Rao', roles.emp, []),
    user('bm', 'Faiz', 'Patel', roles.bm, [BOM]),
    user('bmNbo', 'Aamir', 'Shaikh', roles.bm, [NBO, DEAD]),
    user('bmNoApp', 'No', 'App', roles.bm, [BOM], false),
    user('cm', 'Pravesh', 'Jha', roles.cm, []),
    user('owner', 'Afshin', 'Dhanani', roles.owner, []),
  ]);

  const { signAccess } = require('../../../modules/auth/jwt');
  for (const k of Object.keys(ids)) tokens[k] = signAccess(ids[k], 'employee');
  app = require('../../app').createMongoApp();
  ready = true;
}, 60000);

afterAll(async () => {
  if (!mongo) return;
  if (ready) {
    for (const db of [mongo.crmDb(), mongo.appDb()]) {
      if (/^kb360_e2e_/.test(db.name)) await db.dropDatabase();
    }
  }
  await mongo.disconnectMongo();
}, 30000);

// Level 1: BOTH managers · Level 2: EITHER the owner or finance · Level 3: Nandni
const LEVELS = () => [
  { label: 'Managers', mode: 'all', approverIds: [ids.bm, ids.cm] },
  { mode: 'any', approverIds: [ids.owner, ids.fin] },
  { approverIds: [ids.outsider] },
];
const legacyPicks = () => [
  { step: 'branch_manager', userId: ids.bm },
  { step: 'company_manager', userId: ids.cm },
  { step: 'business_owner', userId: ids.owner },
];
const raise = async (title: string, body: Record<string, unknown> = { levels: LEVELS() }) => {
  const res = await request(app).post('/api/approvals').set(as('emp')).send({ title, details: `${title} — details`, ...body });
  expect(res.status).toBe(201);
  return res.body as any;
};
const listOf = async (who: string, query = '') => (await request(app).get(`/api/approvals${query}`).set(as(who))).body as any;
const getAs = (who: string, id: string) => request(app).get(`/api/approvals/${id}`).set(as(who));
const decide = (who: string, id: string, action: string, note?: string) => request(app).put(`/api/approvals/${id}/decision`).set(as(who)).send({ action, ...(note ? { note } : {}) });
const levelStatuses = (a: any): string[][] => a.levels.map((l: any) => [l.status, ...l.approvers.map((x: any) => x.status)]);

describe('approvals — N-level chain over HTTP (local throwaway Mongo)', () => {
  it('no token → 401', async () => {
    if (!ready) return;
    expect((await request(app).get('/api/approvals')).status).toBe(401);
  });

  it('hierarchy: level-builder limits, everyone pickable (never yourself, never app-less), a role-based suggestion, and the legacy steps', async () => {
    if (!ready) return;
    const res = await request(app).get('/api/approvals/hierarchy').set(as('emp'));
    expect(res.status).toBe(200);
    expect(res.body.levels).toEqual({ min: 1, max: 10, maxApproversPerLevel: 10, labelMaxLength: 40, modes: ['all', 'any'], defaultMode: 'all' });
    expect(res.body.approvers.map((c: any) => c.name)).toEqual(['Aamir Shaikh', 'Afshin Dhanani', 'Faiz Patel', 'Kiran Rao', 'Nandni Shah', 'Pravesh Jha']);
    expect(res.body.approvers.find((c: any) => c.id === ids.bm)).toMatchObject({ name: 'Faiz Patel', initials: 'FP', email: 'bm@e2e.test', role: 'branch_manager', level: 3, branches: ['BOM'] });
    expect(res.body.suggestedLevels).toEqual([
      { order: 1, label: 'Branch manager', mode: 'all', approverIds: [ids.bm], candidateIds: [ids.bm] },
      { order: 2, label: 'Company manager', mode: 'all', approverIds: [ids.cm], candidateIds: [ids.cm] },
      { order: 3, label: 'Business owner', mode: 'all', approverIds: [ids.owner], candidateIds: [ids.owner] },
    ]);
    // the previous app build's fixed chain is still served
    expect(res.body.totalSteps).toBe(3);
    expect(res.body.steps.map((s: any) => [s.order, s.key, s.label, s.required])).toEqual([
      [1, 'branch_manager', 'Branch manager', true],
      [2, 'company_manager', 'Company manager', true],
      [3, 'business_owner', 'Business owner', true],
    ]);
    expect(res.body.steps[0].candidates.map((c: any) => c.name)).toEqual(['Faiz Patel']);
    expect(res.body.steps[0].defaultApproverId).toBe(ids.bm);
    expect(res.body.categories).toContain('Salary');
    expect(res.body.limits).toMatchObject({ title: 120, details: 2000, note: 500, levels: 10, approversPerLevel: 10 });
  });

  it('approvers: the searchable people picker', async () => {
    if (!ready) return;
    const all = await request(app).get('/api/approvals/approvers').set(as('emp'));
    expect(all.status).toBe(200);
    expect(all.body.total).toBe(6);
    expect(all.body.items.map((c: any) => c.id)).not.toContain(ids.emp);
    expect(all.body.items.map((c: any) => c.id)).not.toContain(ids.bmNoApp);
    const byName = await request(app).get('/api/approvals/approvers?q=faiz').set(as('emp'));
    expect(byName.body.items.map((c: any) => c.name)).toEqual(['Faiz Patel']);
    const byBranch = await request(app).get('/api/approvals/approvers?q=nbo&limit=1').set(as('emp'));
    expect(byBranch.body).toMatchObject({ total: 1, items: [{ name: 'Aamir Shaikh' }] });
    const byRole = await request(app).get('/api/approvals/approvers?q=branch_manager').set(as('emp'));
    expect(byRole.body.items.map((c: any) => c.name)).toEqual(['Aamir Shaikh', 'Faiz Patel']);
  });

  it('create refuses a bad chain', async () => {
    if (!ready) return;
    const post = (body: unknown) => request(app).post('/api/approvals').set(as('emp')).send({ title: 'x', details: 'y', ...(body as object) });
    const code = async (body: unknown) => {
      const r = await post(body);
      return [r.status, r.body.error.code];
    };
    expect(await code({})).toEqual([400, 'VALIDATION']); // neither levels nor approvers
    expect(await code({ levels: [] })).toEqual([400, 'VALIDATION']);
    expect(await code({ levels: [{ approverIds: [] }] })).toEqual([400, 'VALIDATION']);
    expect(await code({ levels: [{ approverIds: [ids.emp] }] })).toEqual([400, 'BAD_REQUEST']); // yourself
    expect(await code({ levels: [{ approverIds: [ids.bm] }, { approverIds: [ids.bm] }] })).toEqual([400, 'BAD_REQUEST']); // twice
    expect(await code({ levels: [{ approverIds: [ids.bmNoApp] }] })).toEqual([400, 'BAD_REQUEST']); // cannot open the app
    expect(await code({ levels: [{ approverIds: [String(new Types.ObjectId())] }] })).toEqual([400, 'BAD_REQUEST']); // nobody
    expect((await post({ levels: [{ mode: 'majority', approverIds: [ids.bm] }] })).status).toBe(400);
    expect((await request(app).post('/api/approvals').set(as('emp')).send({ title: '', details: 'y', levels: LEVELS() })).status).toBe(400);
    // legacy role picks are still checked against the fixed hierarchy
    expect(await code({ approvers: legacyPicks().slice(0, 2) })).toEqual([400, 'BAD_REQUEST']);
    expect(await code({ approvers: [{ step: 'branch_manager', userId: ids.bmNbo }, ...legacyPicks().slice(1)] })).toEqual([400, 'BAD_REQUEST']);
  });

  it('level 1 (both) → level 2 (either) → level 3, each only when the one before is done', async () => {
    if (!ready) return;
    const created = await raise('Salary release approval');
    const id = created.id;
    expect(created).toMatchObject({ status: 'pending', category: 'Salary', totalLevels: 3, currentLevel: 1, isMine: true, canAct: false, canCancel: true, myDecision: null });
    expect(created.requester.name).toBe('Rohan Mehta');
    expect(created.currentApprovers.map((p: any) => p.name)).toEqual(['Faiz Patel', 'Pravesh Jha']);
    expect(created.levels.map((l: any) => [l.order, l.label, l.mode, l.status, l.isCurrent, l.approvedCount, l.requiredCount])).toEqual([
      [1, 'Managers', 'all', 'pending', true, 0, 2],
      [2, 'Level 2', 'any', 'waiting', false, 0, 1],
      [3, 'Level 3', 'all', 'waiting', false, 0, 1],
    ]);
    expect(created.levels[1].approvers.map((a: any) => a.approver.name)).toEqual(['Afshin Dhanani', 'Kiran Rao']);
    // mirrors for the previous app build: one row per approver, unique row numbers
    expect(created).toMatchObject({ totalSteps: 3, currentStep: 1 });
    expect(created.currentApprover.name).toBe('Faiz Patel');
    expect(created.steps.map((s: any) => [s.order, s.level, s.key, s.label, s.approver.name, s.status, s.isCurrent])).toEqual([
      [1, 1, 'level_1', 'Managers', 'Faiz Patel', 'pending', true],
      [2, 1, 'level_1', 'Managers', 'Pravesh Jha', 'pending', true],
      [3, 2, 'level_2', 'Level 2', 'Afshin Dhanani', 'waiting', false],
      [4, 2, 'level_2', 'Level 2', 'Kiran Rao', 'waiting', false],
      [5, 3, 'level_3', 'Level 3', 'Nandni Shah', 'waiting', false],
    ]);

    // it has come to level 1 ONLY — both managers, nobody else (the owner is a super admin and
    // may look anything up by id; finance and Nandni cannot)
    for (const who of ['bm', 'cm']) expect((await listOf(who, '?scope=actionable')).items.map((i: any) => [i.id, i.canAct])).toEqual([[id, true]]);
    expect((await request(app).get('/api/approvals/counts').set(as('cm'))).body.actionable).toBe(1);
    expect((await listOf('fin')).items).toEqual([]);
    expect((await listOf('owner')).items).toEqual([]);
    expect((await getAs('fin', id)).status).toBe(404);
    expect((await getAs('outsider', id)).status).toBe(404);
    const early = await decide('fin', id, 'approve');
    expect([early.status, early.body.error.code]).toEqual([409, 'NOT_YOUR_TURN']);
    expect((await decide('bmNbo', id, 'approve')).status).toBe(404);

    // ONE manager approves → the level stays open for the other
    const one = await decide('bm', id, 'approve', 'fine by me');
    expect(one.status).toBe(200);
    expect(one.body).toMatchObject({ status: 'pending', currentLevel: 1, canAct: false, myDecision: 'approved' });
    expect(one.body.levels[0]).toMatchObject({ status: 'pending', isCurrent: true, approvedCount: 1, requiredCount: 2 });
    expect(one.body.levels[0].approvers[0]).toMatchObject({ status: 'approved', note: 'fine by me' });
    expect(one.body.currentApprovers.map((p: any) => p.name)).toEqual(['Pravesh Jha']);
    const again = await decide('bm', id, 'approve');
    expect([again.status, again.body.error.code]).toEqual([409, 'ALREADY_DECIDED']);
    expect((await listOf('bm', '?scope=actionable')).items).toEqual([]);
    expect((await listOf('bm')).items.map((i: any) => i.id)).toEqual([id]); // still sees what they decided
    expect((await listOf('cm', '?scope=actionable')).items.map((i: any) => i.id)).toEqual([id]);
    expect((await getAs('fin', id)).status).toBe(404); // level 2 still hears nothing

    // the OTHER manager approves → level 1 closes, level 2 (either owner or finance) opens
    const two = await decide('cm', id, 'approve');
    expect(two.body).toMatchObject({ status: 'pending', currentLevel: 2 });
    expect(levelStatuses(two.body)).toEqual([['approved', 'approved', 'approved'], ['pending', 'pending', 'pending'], ['waiting', 'waiting']]);
    expect(two.body.levels[0].decidedAt).toBeTruthy();
    for (const who of ['owner', 'fin']) expect((await listOf(who, '?scope=actionable')).items.map((i: any) => i.canAct)).toEqual([true]);
    expect((await getAs('outsider', id)).status).toBe(404);

    // finance approves first → the owner's slot is skipped, but they keep seeing it
    const three = await decide('fin', id, 'approve');
    expect(three.body).toMatchObject({ status: 'pending', currentLevel: 3 });
    expect(levelStatuses(three.body)).toEqual([['approved', 'approved', 'approved'], ['approved', 'skipped', 'approved'], ['pending', 'pending']]);
    expect((await listOf('owner', '?scope=actionable')).items).toEqual([]);
    expect((await listOf('owner')).items.map((i: any) => [i.id, i.canAct, i.myDecision])).toEqual([[id, false, null]]);
    const late = await decide('owner', id, 'approve');
    expect([late.status, late.body.error.code]).toEqual([409, 'ALREADY_DECIDED']);

    // level 3 → approved
    expect((await listOf('outsider', '?scope=actionable')).items.map((i: any) => i.id)).toEqual([id]);
    const done = await decide('outsider', id, 'approve');
    expect(done.body).toMatchObject({ status: 'approved', currentLevel: null, currentApprovers: [], currentStep: null, currentApprover: null, canAct: false });
    expect(done.body.decidedAt).toBeTruthy();
    expect(done.body.levels.map((l: any) => l.status)).toEqual(['approved', 'approved', 'approved']);
    const after = await decide('outsider', id, 'reject');
    expect([after.status, after.body.error.code]).toEqual([409, 'NOT_PENDING']);

    const mine = await listOf('emp', '?status=approved');
    expect(mine.items.map((i: any) => i.id)).toEqual([id]);
    expect(mine.counts).toMatchObject({ all: 1, approved: 1, pending: 0, rejected: 0 });
  });

  it('a rejection by anyone on the level ends it — the rest of the level and later levels never act', async () => {
    if (!ready) return;
    const { id } = await raise('Client visit expense approval');
    const res = await decide('cm', id, 'reject', 'over budget');
    expect(res.body).toMatchObject({ status: 'rejected', category: 'Expense', myDecision: 'rejected', currentLevel: null });
    expect(levelStatuses(res.body)).toEqual([['rejected', 'skipped', 'rejected'], ['skipped', 'skipped', 'skipped'], ['skipped', 'skipped']]);
    expect((await getAs('bm', id)).status).toBe(200); // it had reached their level
    expect((await listOf('bm', '?scope=actionable')).items).toEqual([]);
    expect((await getAs('fin', id)).status).toBe(404); // never got there
    expect((await getAs('owner', id)).status).toBe(200); // super-admin oversight
    expect((await listOf('emp', '?status=rejected')).items[0].levels[0].approvers[1].note).toBe('over budget');
  });

  it('the requester can withdraw while it is pending — what was decided stays, the rest is skipped', async () => {
    if (!ready) return;
    const { id } = await raise('Work from home request');
    expect((await request(app).put(`/api/approvals/${id}/cancel`).set(as('bm'))).status).toBe(404);
    expect((await decide('bm', id, 'approve')).status).toBe(200);
    const res = await request(app).put(`/api/approvals/${id}/cancel`).set(as('emp'));
    expect(res.body).toMatchObject({ status: 'cancelled', canCancel: false, category: 'HR' });
    expect(levelStatuses(res.body)).toEqual([['skipped', 'approved', 'skipped'], ['skipped', 'skipped', 'skipped'], ['skipped', 'skipped']]);
    expect((await getAs('bm', id)).status).toBe(200); // they decided — they keep it
    expect((await getAs('cm', id)).status).toBe(404); // withdrawn before they acted — gone
    expect((await listOf('cm', '?scope=actionable')).items).toEqual([]);
    expect((await request(app).put(`/api/approvals/${id}/cancel`).set(as('emp'))).status).toBe(409);
    const all = await listOf('emp', '?limit=2&page=1');
    expect([all.total, all.items.length, all.hasMore]).toEqual([3, 2, true]);
    expect(all.items[0].id).toBe(id); // newest first
  });

  it('the previous app build still works: role picks become one single-person level per step', async () => {
    if (!ready) return;
    const created = await raise('Leave approval', { approvers: legacyPicks() });
    expect(created).toMatchObject({ category: 'Leave', totalLevels: 3, totalSteps: 3, currentStep: 1 });
    expect(created.levels.map((l: any) => [l.key, l.label, l.mode, l.approvers.length])).toEqual([
      ['branch_manager', 'Branch manager', 'all', 1],
      ['company_manager', 'Company manager', 'all', 1],
      ['business_owner', 'Business owner', 'all', 1],
    ]);
    expect(created.steps.map((s: any) => [s.order, s.key, s.approver.name, s.status])).toEqual([
      [1, 'branch_manager', 'Faiz Patel', 'pending'],
      [2, 'company_manager', 'Pravesh Jha', 'waiting'],
      [3, 'business_owner', 'Afshin Dhanani', 'waiting'],
    ]);
    const one = await decide('bm', created.id, 'approve');
    expect(one.body).toMatchObject({ currentLevel: 2, currentStep: 2 });
    expect(one.body.currentApprover.name).toBe('Pravesh Jha');
    expect(one.body.steps.map((s: any) => s.status)).toEqual(['approved', 'pending', 'waiting']);
    // a branch manager's own legacy form still starts one step up
    const bm = await request(app).get('/api/approvals/hierarchy').set(as('bm'));
    expect(bm.body.steps.map((s: any) => s.key)).toEqual(['company_manager', 'business_owner']);
  });

  it('boot migration: a request written before N-level chains keeps moving', async () => {
    if (!ready) return;
    const { migrateLegacyApprovalChains } = require('../approval.migrate');
    const coll = mongo.appDb().db.collection('approval_requests');
    const _id = new Types.ObjectId();
    const at = new Date('2026-09-19T05:00:00Z');
    await coll.insertOne({
      _id,
      tenantId: null,
      requesterId: ids.emp,
      title: 'Old-style purchase approval',
      details: 'written by the previous build',
      category: 'Purchase',
      status: 'pending',
      currentStep: 1,
      steps: [
        { key: 'branch_manager', label: 'Branch manager', approverId: ids.bm, status: 'approved', decidedAt: at, note: 'ok' },
        { key: 'company_manager', label: 'Company manager', approverId: ids.cm, status: 'pending', decidedAt: null, note: '' },
        { key: 'business_owner', label: 'Business owner', approverId: ids.owner, status: 'waiting', decidedAt: null, note: '' },
      ],
      submittedAt: at,
      decidedAt: null,
      createdAt: at,
      updatedAt: at,
    });
    expect(await migrateLegacyApprovalChains()).toBe(1);
    expect(await migrateLegacyApprovalChains()).toBe(0); // idempotent
    const raw = await coll.findOne({ _id });
    expect(raw.steps).toBeUndefined();
    expect(raw.currentStep).toBeUndefined();
    expect(raw.currentLevel).toBe(1);

    const id = String(_id);
    const asCm = await getAs('cm', id);
    expect(asCm.status).toBe(200);
    expect(asCm.body).toMatchObject({ currentLevel: 2, currentStep: 2, canAct: true, totalLevels: 3 });
    expect(asCm.body.levels[0]).toMatchObject({ key: 'branch_manager', label: 'Branch manager', status: 'approved' });
    expect(asCm.body.levels[0].approvers[0]).toMatchObject({ status: 'approved', note: 'ok', decidedAt: at.toISOString() });
    expect(asCm.body.steps.map((s: any) => [s.key, s.status])).toEqual([['branch_manager', 'approved'], ['company_manager', 'pending'], ['business_owner', 'waiting']]);
    expect((await listOf('cm', '?scope=actionable')).items.map((i: any) => i.id)).toContain(id);
    expect((await listOf('bm')).items.map((i: any) => i.id)).toContain(id);
    // …and the chain carries on from where it was
    const res = await decide('cm', id, 'approve');
    expect(res.body).toMatchObject({ currentLevel: 3 });
    expect(res.body.currentApprovers.map((p: any) => p.name)).toEqual(['Afshin Dhanani']);
  });
});
