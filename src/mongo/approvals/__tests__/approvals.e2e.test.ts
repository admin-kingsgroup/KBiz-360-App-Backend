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

const picks = () => [
  { step: 'branch_manager', userId: ids.bm },
  { step: 'company_manager', userId: ids.cm },
  { step: 'business_owner', userId: ids.owner },
];
const raise = async (title: string) => {
  const res = await request(app).post('/api/approvals').set(as('emp')).send({ title, details: `${title} — details`, approvers: picks() });
  expect(res.status).toBe(201);
  return res.body as any;
};
const listOf = async (who: string, query = '') => (await request(app).get(`/api/approvals${query}`).set(as(who))).body as any;

describe('approvals — chain over HTTP (local throwaway Mongo)', () => {
  it('no token → 401', async () => {
    if (!ready) return;
    expect((await request(app).get('/api/approvals')).status).toBe(401);
  });

  it('hierarchy: three steps, own-branch manager only, app-less and dead-branch people excluded', async () => {
    if (!ready) return;
    const res = await request(app).get('/api/approvals/hierarchy').set(as('emp'));
    expect(res.status).toBe(200);
    expect(res.body.totalSteps).toBe(3);
    expect(res.body.steps.map((s: any) => [s.order, s.key, s.label, s.required])).toEqual([
      [1, 'branch_manager', 'Branch manager', true],
      [2, 'company_manager', 'Company manager', true],
      [3, 'business_owner', 'Business owner', true],
    ]);
    expect(res.body.steps[0].candidates.map((c: any) => c.name)).toEqual(['Faiz Patel']);
    expect(res.body.steps[0].defaultApproverId).toBe(ids.bm);
    expect(res.body.steps[2].candidates[0]).toMatchObject({ id: ids.owner, name: 'Afshin Dhanani', initials: 'AD' });
    // a branch manager's own form starts one step up
    const bm = await request(app).get('/api/approvals/hierarchy').set(as('bm'));
    expect(bm.body.steps.map((s: any) => s.key)).toEqual(['company_manager', 'business_owner']);
  });

  it('create refuses a bad chain', async () => {
    if (!ready) return;
    const post = (approvers: unknown) => request(app).post('/api/approvals').set(as('emp')).send({ title: 'x', details: 'y', approvers });
    expect((await post(picks().slice(0, 2))).status).toBe(400); // a step left empty
    expect((await post([{ step: 'branch_manager', userId: ids.bmNbo }, ...picks().slice(1)])).status).toBe(400); // other branch
    expect((await post([{ step: 'branch_manager', userId: ids.bmNoApp }, ...picks().slice(1)])).status).toBe(400); // cannot open the app
    expect((await request(app).post('/api/approvals').set(as('emp')).send({ title: '', details: 'y', approvers: picks() })).status).toBe(400);
  });

  it('level 1 → level 2 → level 3, each only when the one before approved', async () => {
    if (!ready) return;
    const created = await raise('Salary release approval');
    const id = created.id;
    expect(created).toMatchObject({ status: 'pending', category: 'Salary', totalSteps: 3, currentStep: 1, isMine: true, canAct: false, canCancel: true });
    expect(created.requester.name).toBe('Rohan Mehta');
    expect(created.currentApprover.name).toBe('Faiz Patel');
    expect(created.steps.map((s: any) => [s.status, s.isCurrent])).toEqual([['pending', true], ['waiting', false], ['waiting', false]]);

    // it has come to level 1 ONLY
    expect((await listOf('bm', '?scope=actionable')).items.map((i: any) => [i.id, i.canAct])).toEqual([[id, true]]);
    expect((await request(app).get('/api/approvals/counts').set(as('bm'))).body.actionable).toBe(1);
    expect((await listOf('cm')).items).toEqual([]);
    expect((await request(app).get(`/api/approvals/${id}`).set(as('cm'))).status).toBe(404);
    expect((await request(app).get(`/api/approvals/${id}`).set(as('outsider'))).status).toBe(404);
    const early = await request(app).put(`/api/approvals/${id}/decision`).set(as('cm')).send({ action: 'approve' });
    expect([early.status, early.body.error.code]).toEqual([409, 'NOT_YOUR_TURN']);
    expect((await request(app).put(`/api/approvals/${id}/decision`).set(as('outsider')).send({ action: 'approve' })).status).toBe(404);

    // level 1 approves → it moves to level 2
    const one = await request(app).put(`/api/approvals/${id}/decision`).set(as('bm')).send({ action: 'approve', note: 'fine by me' });
    expect(one.status).toBe(200);
    expect(one.body).toMatchObject({ status: 'pending', currentStep: 2, canAct: false, myDecision: 'approved' });
    expect(one.body.steps[0]).toMatchObject({ status: 'approved', note: 'fine by me', isCurrent: false });
    expect(one.body.steps[1]).toMatchObject({ status: 'pending', isCurrent: true });
    const again = await request(app).put(`/api/approvals/${id}/decision`).set(as('bm')).send({ action: 'approve' });
    expect([again.status, again.body.error.code]).toEqual([409, 'ALREADY_DECIDED']);
    expect((await listOf('bm', '?scope=actionable')).items).toEqual([]);
    expect((await listOf('bm')).items.map((i: any) => i.id)).toEqual([id]); // still sees what they decided
    expect((await listOf('cm', '?scope=actionable')).items.map((i: any) => i.id)).toEqual([id]);

    // level 2, then level 3 → approved
    expect((await request(app).put(`/api/approvals/${id}/decision`).set(as('cm')).send({ action: 'approve' })).body.currentStep).toBe(3);
    const done = await request(app).put(`/api/approvals/${id}/decision`).set(as('owner')).send({ action: 'approve' });
    expect(done.body).toMatchObject({ status: 'approved', currentStep: null, currentApprover: null, canAct: false });
    expect(done.body.decidedAt).toBeTruthy();
    expect(done.body.steps.map((s: any) => s.status)).toEqual(['approved', 'approved', 'approved']);
    const late = await request(app).put(`/api/approvals/${id}/decision`).set(as('owner')).send({ action: 'reject' });
    expect([late.status, late.body.error.code]).toEqual([409, 'NOT_PENDING']);

    const mine = await listOf('emp', '?status=approved');
    expect(mine.items.map((i: any) => i.id)).toEqual([id]);
    expect(mine.counts).toMatchObject({ all: 1, approved: 1, pending: 0, rejected: 0 });
  });

  it('a rejection ends it — later levels never see it', async () => {
    if (!ready) return;
    const { id } = await raise('Client visit expense approval');
    const res = await request(app).put(`/api/approvals/${id}/decision`).set(as('bm')).send({ action: 'reject', note: 'over budget' });
    expect(res.body).toMatchObject({ status: 'rejected', category: 'Expense', myDecision: 'rejected', currentStep: null });
    expect(res.body.steps.map((s: any) => s.status)).toEqual(['rejected', 'skipped', 'skipped']);
    expect((await listOf('cm')).items.map((i: any) => i.id)).not.toContain(id);
    expect((await request(app).get(`/api/approvals/${id}`).set(as('cm'))).status).toBe(404);
    expect((await request(app).get(`/api/approvals/${id}`).set(as('owner'))).status).toBe(200); // super-admin oversight
    expect((await listOf('emp', '?status=rejected')).items[0].steps[0].note).toBe('over budget');
  });

  it('the requester can withdraw while it is pending — nobody else can', async () => {
    if (!ready) return;
    const { id } = await raise('Work from home request');
    expect((await request(app).put(`/api/approvals/${id}/cancel`).set(as('bm'))).status).toBe(404);
    const res = await request(app).put(`/api/approvals/${id}/cancel`).set(as('emp'));
    expect(res.body).toMatchObject({ status: 'cancelled', canCancel: false, category: 'HR' });
    expect(res.body.steps.map((s: any) => s.status)).toEqual(['skipped', 'skipped', 'skipped']);
    expect((await listOf('bm', '?scope=actionable')).items).toEqual([]);
    expect((await request(app).put(`/api/approvals/${id}/cancel`).set(as('emp'))).status).toBe(409);
    const all = await listOf('emp', '?limit=2&page=1');
    expect([all.total, all.items.length, all.hasMore]).toEqual([3, 2, true]);
    expect(all.items[0].id).toBe(id); // newest first
  });
});
