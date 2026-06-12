import request from 'supertest';
import { createApp } from '../../../app';
import { prisma } from '../../../db/prisma';

// Integration — real app + Prisma + Postgres. Requires a migrated, SEEDED DB; self-skips otherwise.
const app = createApp();
const SUPER = { identifier: 'afshin@kbiz360.com', password: 'kbiz360' }; // a1 Super Admin → canManage
const EMPLOYEE = { identifier: 'rohan@travkings.com', password: 'kbiz360' }; // a6 Employee → cannot manage

let dbReady = false;

async function token(creds: { identifier: string; password: string }): Promise<string> {
  const res = await request(app).post('/api/auth/login').send(creds);
  return res.body.accessToken as string;
}

beforeAll(async () => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    const a = await prisma.user.findFirst({ where: { email: SUPER.identifier } });
    dbReady = Boolean(a?.passwordHash);
    if (!dbReady) console.warn('[users.integration] DB reachable but not seeded — skipping.');
  } catch {
    console.warn('[users.integration] DB unreachable — skipping.');
  }
});

afterAll(async () => {
  // Clean up any leftover test user so the suite is re-runnable.
  if (dbReady) await prisma.user.deleteMany({ where: { email: 'newhire@travkings.com' } });
  await prisma.$disconnect();
});

const validEmployeeDraft = {
  name: 'New Hire',
  email: 'newhire@travkings.com',
  role: 'EMPLOYEE' as const,
  bizId: 'tk',
  branches: ['AMD'],
  accessGroups: ['AMD-Accounts'],
  accessDepts: ['AMD-Accounts'],
  accessAlerts: ['AMD-accounts'],
};

describe('Users CRUD (access-scoped + validated)', () => {
  let createdId = '';

  it('GET /api/users (authed) lists seeded users', async () => {
    if (!dbReady) return;
    const t = await token(SUPER);
    const res = await request(app).get('/api/users').set('Authorization', `Bearer ${t}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.some((u: { name: string }) => u.name === 'Afshin Dhanani')).toBe(true);
  });

  it('GET /api/users without auth → 401', async () => {
    if (!dbReady) return;
    expect((await request(app).get('/api/users')).status).toBe(401);
  });

  it('POST /api/users as Super with valid draft → 201', async () => {
    if (!dbReady) return;
    const t = await token(SUPER);
    const res = await request(app).post('/api/users').set('Authorization', `Bearer ${t}`).send(validEmployeeDraft);
    expect(res.status).toBe(201);
    expect(res.body.id).toBeTruthy();
    expect(res.body.initials).toBe('NH');
    createdId = res.body.id;
  });

  it('POST /api/users invalid draft (missing grants) → 400 with ValidationResult', async () => {
    if (!dbReady) return;
    const t = await token(SUPER);
    const res = await request(app)
      .post('/api/users')
      .set('Authorization', `Bearer ${t}`)
      .send({ ...validEmployeeDraft, email: 'x2@travkings.com', accessAlerts: [] });
    expect(res.status).toBe(400);
    expect(res.body.error.details.alertsOK).toBe(false);
  });

  it('POST /api/users as Employee (no manage) → 403', async () => {
    if (!dbReady) return;
    const t = await token(EMPLOYEE);
    const res = await request(app)
      .post('/api/users')
      .set('Authorization', `Bearer ${t}`)
      .send({ ...validEmployeeDraft, email: 'x3@travkings.com' });
    expect(res.status).toBe(403);
  });

  it('PATCH /api/users/:id renames in place', async () => {
    if (!dbReady) return;
    const t = await token(SUPER);
    const res = await request(app)
      .patch(`/api/users/${createdId}`)
      .set('Authorization', `Bearer ${t}`)
      .send({ name: 'New Hire Renamed' });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('New Hire Renamed');
  });

  it('DELETE /api/users/:id → 204 then 404', async () => {
    if (!dbReady) return;
    const t = await token(SUPER);
    expect((await request(app).delete(`/api/users/${createdId}`).set('Authorization', `Bearer ${t}`)).status).toBe(204);
    expect((await request(app).get(`/api/users/${createdId}`).set('Authorization', `Bearer ${t}`)).status).toBe(404);
  });
});
