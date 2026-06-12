import request from 'supertest';
import { createApp } from '../../../app';
import { prisma } from '../../../db/prisma';

// Integration — audit log is Super-only; reads the trail prior phases (and login) write.
const app = createApp();
const SUPER = { identifier: 'afshin@kbiz360.com', password: 'kbiz360' }; // a1 (isSuper)
const ROHAN = { identifier: 'rohan@travkings.com', password: 'kbiz360' }; // a6 (not super)

let dbReady = false;
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const tok = async (c: { identifier: string; password: string }) =>
  (await request(app).post('/api/auth/login').send(c)).body.accessToken as string;

beforeAll(async () => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    const a = await prisma.user.findFirst({ where: { email: SUPER.identifier } });
    dbReady = Boolean(a?.passwordHash);
  } catch {
    /* skip */
  }
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('Audit — GET /audit (Super only)', () => {
  it('Super lists audit entries (login itself is audited)', async () => {
    if (!dbReady) return;
    const res = await request(app).get('/api/audit').set(auth(await tok(SUPER)));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.items)).toBe(true);
    expect(res.body.total).toBeGreaterThanOrEqual(1);
    expect(typeof res.body.items[0].action).toBe('string');
  });

  it('filter ?action=LOGIN returns only LOGIN entries; GET /audit/:id works', async () => {
    if (!dbReady) return;
    const t = await tok(SUPER);
    const list = await request(app).get('/api/audit?action=LOGIN&limit=5').set(auth(t));
    expect(list.body.items.every((a: { action: string }) => a.action === 'LOGIN')).toBe(true);
    const id = list.body.items[0].id;
    const one = await request(app).get(`/api/audit/${id}`).set(auth(t));
    expect(one.status).toBe(200);
    expect(one.body.id).toBe(id);
  });

  it('non-Super → 403', async () => {
    if (!dbReady) return;
    const res = await request(app).get('/api/audit').set(auth(await tok(ROHAN)));
    expect(res.status).toBe(403);
  });

  it('without auth → 401', async () => {
    if (!dbReady) return;
    expect((await request(app).get('/api/audit')).status).toBe(401);
  });
});
