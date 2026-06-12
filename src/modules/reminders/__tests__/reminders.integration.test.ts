import request from 'supertest';
import { createApp } from '../../../app';
import { prisma } from '../../../db/prisma';

// Integration — reproduces canSee.test / reminderGrouping.test / remindersStore.test over the API.
// Requires a migrated, SEEDED DB; self-skips otherwise. Cleans up any reminders it creates.
const app = createApp();
const SUPER = { identifier: 'afshin@kbiz360.com', password: 'kbiz360' }; // a1 → reminder id 'a' (CURRENT_USER_ID)

let dbReady = false;
let tok = '';
const auth = () => ({ Authorization: `Bearer ${tok}` });

beforeAll(async () => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    const a = await prisma.user.findFirst({ where: { email: SUPER.identifier } });
    dbReady = Boolean(a?.passwordHash);
    if (!dbReady) console.warn('[reminders.integration] DB reachable but not seeded — skipping.');
  } catch {
    console.warn('[reminders.integration] DB unreachable — skipping.');
  }
  if (dbReady) {
    await prisma.reminder.deleteMany({ where: { id: { startsWith: 'r-' } } }); // clean prior runs
    tok = (await request(app).post('/api/auth/login').send(SUPER)).body.accessToken;
  }
});

afterAll(async () => {
  if (dbReady) await prisma.reminder.deleteMany({ where: { id: { startsWith: 'r-' } } });
  await prisma.$disconnect();
});

describe('Reminders — visibility + grouping + state machine (over the API)', () => {
  // ── reads (seed-based; run before mutations) ──
  it('All tab (Super) → person-wise groups, ordered by RANK then name', async () => {
    if (!dbReady) return;
    const res = await request(app).get('/api/reminders?tab=all').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.groups.every((g: { mode: string }) => g.mode === 'person')).toBe(true);
    expect(res.body.groups.map((g: { key: string }) => g.key)).toEqual(['a', 'p', 'f', 'm', 'ko', 'r', 'sn']);
    const total = res.body.groups.reduce((n: number, g: { items: unknown[] }) => n + g.items.length, 0);
    expect(total).toBe(14); // 16 seed − 2 approved
  });

  it('All tab viewAs=BRANCH_MANAGER (Super override) → only AMD HOD/staff below (f,m,r)', async () => {
    if (!dbReady) return;
    const res = await request(app).get('/api/reminders?tab=all&viewAs=BRANCH_MANAGER').set(auth());
    expect(res.body.groups.map((g: { key: string }) => g.key)).toEqual(['f', 'm', 'r']);
  });

  it('For me tab → role-tier group, pending reminders for current user (a)', async () => {
    if (!dbReady) return;
    const res = await request(app).get('/api/reminders?tab=forme').set(auth());
    expect(res.body.visible.length).toBe(3); // r1,r2,r3
    expect(res.body.groups[0].mode).toBe('role');
    expect(res.body.groups[0].key).toBe('SUPER_ADMIN');
  });

  it('I set tab → pending reminders I created for others', async () => {
    if (!dbReady) return;
    const res = await request(app).get('/api/reminders?tab=iset').set(auth());
    expect(res.body.visible.length).toBe(4); // r4,r5,rb1,rb2
  });

  it('Review tab → review-state reminders I created; reviewCount matches', async () => {
    if (!dbReady) return;
    const res = await request(app).get('/api/reminders?tab=review').set(auth());
    expect(res.body.visible.length).toBe(2); // r6,r7
    expect(res.body.reviewCount).toBe(2);
  });

  // ── mutations (create / state machine) ──
  it('POST creates a reminder for another (byId=a), visible in I set', async () => {
    if (!dbReady) return;
    const res = await request(app).post('/api/reminders').set(auth()).send({ text: 'Ship the thing', forId: 'r' });
    expect(res.status).toBe(201);
    expect(res.body.byId).toBe('a');
    expect(res.body.forId).toBe('r');
    expect(res.body.forName).toBe('Riya Patel');
    expect(res.body.state).toBe('pending');
  });

  it('complete on other-assigned → review (sent back to creator)', async () => {
    if (!dbReady) return;
    const created = (await request(app).post('/api/reminders').set(auth()).send({ text: 'x', forId: 'm' })).body;
    const res = await request(app).patch(`/api/reminders/${created.id}`).set(auth()).send({ action: 'complete' });
    expect(res.body.result).toBe('review');
    expect(res.body.reminder.state).toBe('review');
  });

  it('complete on self-assigned (forId=a) → archived (approved immediately)', async () => {
    if (!dbReady) return;
    const created = (await request(app).post('/api/reminders').set(auth()).send({ text: 'self', forId: 'a' })).body;
    const res = await request(app).patch(`/api/reminders/${created.id}`).set(auth()).send({ action: 'complete' });
    expect(res.body.result).toBe('archived');
    expect(res.body.reminder.state).toBe('approved');
  });

  it('approve → approved', async () => {
    if (!dbReady) return;
    const created = (await request(app).post('/api/reminders').set(auth()).send({ text: 'y', forId: 'm' })).body;
    await request(app).patch(`/api/reminders/${created.id}`).set(auth()).send({ action: 'complete' }); // → review
    const res = await request(app).patch(`/api/reminders/${created.id}`).set(auth()).send({ action: 'approve' });
    expect(res.body.result).toBe('approved');
    expect(res.body.reminder.state).toBe('approved');
  });

  it('DELETE removes a reminder', async () => {
    if (!dbReady) return;
    const created = (await request(app).post('/api/reminders').set(auth()).send({ text: 'z', forId: 'r' })).body;
    expect((await request(app).delete(`/api/reminders/${created.id}`).set(auth())).status).toBe(204);
  });

  it('GET /reminders without auth → 401', async () => {
    if (!dbReady) return;
    expect((await request(app).get('/api/reminders')).status).toBe(401);
  });
});
