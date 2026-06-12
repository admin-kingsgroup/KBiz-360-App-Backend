import request from 'supertest';
import { createApp } from '../../../app';
import { prisma } from '../../../db/prisma';

// Integration — reproduces homeSegments.test.ts (access filtering / View-As) over the HTTP API.
// Requires a migrated, SEEDED DB; self-skips otherwise.
const app = createApp();
const SUPER = { identifier: 'afshin@kbiz360.com', password: 'kbiz360' }; // a1 Super → sees all
const ROHAN = { identifier: 'rohan@travkings.com', password: 'kbiz360' }; // a6 EMPLOYEE AMD / AMD-Ticketing
const HARSHIT = { identifier: 'harshit@travkings.com', password: 'kbiz360' }; // a5 HOD AMD / AMD-Ticketing

let dbReady = false;

async function token(creds: { identifier: string; password: string }): Promise<string> {
  return (await request(app).post('/api/auth/login').send(creds)).body.accessToken as string;
}
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

beforeAll(async () => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    const a = await prisma.user.findFirst({ where: { email: SUPER.identifier } });
    dbReady = Boolean(a?.passwordHash);
    if (!dbReady) console.warn('[businesses.integration] DB reachable but not seeded — skipping.');
  } catch {
    console.warn('[businesses.integration] DB unreachable — skipping.');
  }
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('Businesses/Org — access-filtered (mirrors homeSegments.test.ts)', () => {
  it('GET /businesses: Super sees all 7; Employee sees only tk', async () => {
    if (!dbReady) return;
    const sup = await request(app).get('/api/businesses').set(auth(await token(SUPER)));
    expect(sup.status).toBe(200);
    expect(sup.body.length).toBe(7);
    expect(sup.body[0].id).toBe('tk'); // display order preserved

    const emp = await request(app).get('/api/businesses').set(auth(await token(ROHAN)));
    expect(emp.body.map((b: { id: string }) => b.id)).toEqual(['tk']);
  });

  it('GET /businesses/:id/branches: Super sees AMD/BOM/NBO; Employee only AMD', async () => {
    if (!dbReady) return;
    const sup = await request(app).get('/api/businesses/tk/branches').set(auth(await token(SUPER)));
    expect(sup.body.map((b: { code: string }) => b.code)).toEqual(['AMD', 'BOM', 'NBO']);

    const emp = await request(app).get('/api/businesses/tk/branches').set(auth(await token(ROHAN)));
    expect(emp.body.map((b: { code: string }) => b.code)).toEqual(['AMD']);
  });

  it('GET /branches/:id/groups: Super sees 5; Employee(Rohan) only Ticketing', async () => {
    if (!dbReady) return;
    const sup = await request(app).get('/api/branches/amd/groups').set(auth(await token(SUPER)));
    expect(sup.body.length).toBe(5);

    const emp = await request(app).get('/api/branches/amd/groups').set(auth(await token(ROHAN)));
    expect(emp.body.map((g: { name: string }) => g.name)).toEqual(['Ticketing']);
  });

  it('GET /groups/:id/departments: HOD(Harshit) sees only Ticketing dept; Super sees 5', async () => {
    if (!dbReady) return;
    const sup = await request(app).get('/api/groups/amd-tkt/departments').set(auth(await token(SUPER)));
    expect(sup.body.length).toBe(5);

    const hod = await request(app).get('/api/groups/amd-tkt/departments').set(auth(await token(HARSHIT)));
    expect(hod.body.map((d: { name: string }) => d.name)).toEqual(['Ticketing']);
  });

  it('GET /businesses/:id out of scope → 403; in scope → 200', async () => {
    if (!dbReady) return;
    const t = await token(ROHAN);
    expect((await request(app).get('/api/businesses/qa').set(auth(t))).status).toBe(403); // qa not granted
    expect((await request(app).get('/api/businesses/tk').set(auth(t))).status).toBe(200);
    const sup = await request(app).get('/api/businesses/qa').set(auth(await token(SUPER)));
    expect(sup.status).toBe(200);
  });

  it('GET /businesses without auth → 401', async () => {
    if (!dbReady) return;
    expect((await request(app).get('/api/businesses')).status).toBe(401);
  });
});
