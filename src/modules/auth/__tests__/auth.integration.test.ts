import request from 'supertest';
import { createApp } from '../../../app';
import { prisma } from '../../../db/prisma';

// Integration suite — exercises the real Express app + Prisma + Postgres. Requires a migrated,
// SEEDED database (npm run prisma:migrate && npm run db:seed). If the DB is unreachable or unseeded,
// the suite self-skips with a warning so the rest of the build stays green.
const app = createApp();
const CREDS = { identifier: 'afshin@kbiz360.com', password: 'kbiz360' };

let dbReady = false;

beforeAll(async () => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    const afshin = await prisma.user.findFirst({ where: { email: CREDS.identifier } });
    dbReady = Boolean(afshin?.passwordHash);
    if (!dbReady) console.warn('[auth.integration] DB reachable but not seeded — skipping live assertions.');
  } catch {
    console.warn('[auth.integration] DB unreachable — skipping live assertions.');
  }
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('Auth flow (login → me → refresh → logout)', () => {
  let accessToken = '';
  let refreshToken = '';

  it('POST /auth/login → 200 with tokens + super access', async () => {
    if (!dbReady) return;
    const res = await request(app).post('/api/auth/login').send(CREDS);
    expect(res.status).toBe(200);
    expect(typeof res.body.accessToken).toBe('string');
    expect(typeof res.body.refreshToken).toBe('string');
    expect(res.body.user.name).toBe('Afshin Dhanani');
    expect(res.body.access.isSuper).toBe(true);
    expect(res.body.access.canManage).toBe(true);
    accessToken = res.body.accessToken;
    refreshToken = res.body.refreshToken;
  });

  it('POST /auth/login wrong password → 401', async () => {
    if (!dbReady) return;
    const res = await request(app).post('/api/auth/login').send({ ...CREDS, password: 'nope' });
    expect(res.status).toBe(401);
  });

  it('GET /auth/me with token → user + derived access', async () => {
    if (!dbReady) return;
    const res = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body.user.id).toBeTruthy();
    expect(res.body.access.isSuper).toBe(true);
  });

  it('GET /auth/me without token → 401', async () => {
    if (!dbReady) return;
    const res = await request(app).get('/api/auth/me');
    expect(res.status).toBe(401);
  });

  it('POST /auth/refresh → new tokens; old refresh is revoked', async () => {
    if (!dbReady) return;
    const res = await request(app).post('/api/auth/refresh').send({ refreshToken });
    expect(res.status).toBe(200);
    expect(typeof res.body.accessToken).toBe('string');
    const rotated = res.body.refreshToken as string;
    expect(rotated).not.toBe(refreshToken);

    // The original (now revoked) refresh token must be rejected.
    const reuse = await request(app).post('/api/auth/refresh').send({ refreshToken });
    expect(reuse.status).toBe(401);
    refreshToken = rotated;
  });

  it('POST /auth/logout → 204 and the token can no longer refresh', async () => {
    if (!dbReady) return;
    const out = await request(app).post('/api/auth/logout').send({ refreshToken });
    expect(out.status).toBe(204);
    const after = await request(app).post('/api/auth/refresh').send({ refreshToken });
    expect(after.status).toBe(401);
  });

  it('GET /auth/me with a malformed token → 401', async () => {
    if (!dbReady) return;
    const res = await request(app).get('/api/auth/me').set('Authorization', 'Bearer not-a-jwt');
    expect(res.status).toBe(401);
  });
});
