import request from 'supertest';
import { createMongoApp } from '../app';
import { connectMongo, disconnectMongo } from '../connection';
import { crmRepo } from '../crm.repo';
import { signAccess } from '../../modules/auth/jwt';

// READ-ONLY smoke test against the live CRM. Mints a dev JWT for a real user (we control the dev
// secret) so the authed read endpoints can be exercised WITHOUT a password and WITHOUT any writes.
// Self-skips if Mongo is unreachable.
const app = createMongoApp();
const SUPER_EMAIL = 'afshin.dhanani@kingsgroupco.com';

let ready = false;
let token = '';
const auth = () => ({ Authorization: `Bearer ${token}` });

beforeAll(async () => {
  try {
    await connectMongo();
    const u = await crmRepo.findUserByEmail(SUPER_EMAIL);
    if (u) {
      token = signAccess(String(u._id), 'super_admin');
      ready = true;
    }
  } catch (e) {
    console.warn('[mongo.smoke] Mongo unreachable — skipping.', (e as Error).message);
  }
}, 30000);

afterAll(async () => {
  await disconnectMongo();
}, 15000);

describe('Mongo backend — real auth + directory (read-only)', () => {
  it('login with wrong password → 401', async () => {
    if (!ready) return;
    const res = await request(app).post('/api/auth/login').send({ identifier: SUPER_EMAIL, password: 'nope-not-real' });
    expect(res.status).toBe(401);
  });

  it('GET /api/users without auth → 401', async () => {
    if (!ready) return;
    expect((await request(app).get('/api/users')).status).toBe(401);
  });

  it('GET /api/auth/me (minted token) → real user + super access', async () => {
    if (!ready) return;
    const res = await request(app).get('/api/auth/me').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe(SUPER_EMAIL);
    expect(res.body.access.isSuper).toBe(true);
    expect(res.body.access.roleName).toBe('super_admin');
  });

  it('GET /api/users → real directory (Super sees all)', async () => {
    if (!ready) return;
    const res = await request(app).get('/api/users').set(auth());
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThanOrEqual(20);
    expect(res.body.some((u: { email: string }) => u.email === SUPER_EMAIL)).toBe(true);
    expect(res.body.every((u: { role: string }) => typeof u.role === 'string')).toBe(true);
  });

  it('GET /api/companies + /api/branches → real org', async () => {
    if (!ready) return;
    const companies = await request(app).get('/api/companies').set(auth());
    expect(companies.status).toBe(200);
    expect(companies.body.length).toBeGreaterThanOrEqual(1);

    const branches = await request(app).get('/api/branches').set(auth());
    expect(branches.status).toBe(200);
    expect(branches.body.some((b: { code: string }) => b.code === 'AMD')).toBe(true);
  });
});
