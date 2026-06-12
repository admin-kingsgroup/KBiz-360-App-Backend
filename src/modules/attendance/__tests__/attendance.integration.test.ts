import request from 'supertest';
import { createApp } from '../../../app';
import { prisma } from '../../../db/prisma';

// Integration — reproduces attendance.test / attendanceFlow over the API (presence → auto/face punch).
// Requires a migrated, SEEDED DB; self-skips otherwise.
const app = createApp();
const SUPER = { identifier: 'afshin@kbiz360.com', password: 'kbiz360' }; // a1 — no branch (Wi-Fi/face only)
const ROHAN = { identifier: 'rohan@travkings.com', password: 'kbiz360' }; // a6 — branch AMD (geofence)

const AMD = { lat: 23.0225, lng: 72.5714 }; // AMD office (matches seed)
const FAR = { lat: 19.076, lng: 72.8777 }; // Mumbai — outside AMD radius

let dbReady = false;
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const tok = async (c: { identifier: string; password: string }) =>
  (await request(app).post('/api/auth/login').send(c)).body.accessToken as string;

beforeAll(async () => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    const a = await prisma.user.findFirst({ where: { email: SUPER.identifier } });
    dbReady = Boolean(a?.passwordHash);
    if (!dbReady) console.warn('[attendance.integration] DB reachable but not seeded — skipping.');
  } catch {
    console.warn('[attendance.integration] DB unreachable — skipping.');
  }
});

// Each test starts from a clean daily punch for both users (team snapshot rows untouched).
beforeEach(async () => {
  if (dbReady) await prisma.attendanceRecord.deleteMany({ where: { userId: { in: ['a1', 'a6'] }, memberName: null } });
});

afterAll(async () => {
  if (dbReady) await prisma.attendanceRecord.deleteMany({ where: { userId: { in: ['a1', 'a6'] }, memberName: null } });
  await prisma.$disconnect();
});

describe('Attendance — presence + punch (over the API)', () => {
  it('Wi-Fi check-in → present via Wi-Fi', async () => {
    if (!dbReady) return;
    const res = await request(app).post('/api/attendance/check-in').set(auth(await tok(SUPER))).send({ wifiOn: true });
    expect(res.status).toBe(200);
    expect(res.body.present).toBe(true);
    expect(res.body.via).toBe('Wi-Fi');
    expect(res.body.inTime).toBeTruthy();
  });

  it('Geofence check-in (Rohan inside AMD) → via Geofence', async () => {
    if (!dbReady) return;
    const res = await request(app).post('/api/attendance/check-in').set(auth(await tok(ROHAN))).send({ coords: AMD });
    expect(res.status).toBe(200);
    expect(res.body.via).toBe('Geofence');
    expect(res.body.distanceMeters).toBeLessThanOrEqual(150);
  });

  it('Off-site check-in → 400 (not present)', async () => {
    if (!dbReady) return;
    const res = await request(app).post('/api/attendance/check-in').set(auth(await tok(ROHAN))).send({ coords: FAR, wifiOn: false });
    expect(res.status).toBe(400);
  });

  it('Face check-in off-site → 400 (blocked)', async () => {
    if (!dbReady) return;
    const res = await request(app).post('/api/attendance/check-in').set(auth(await tok(ROHAN))).send({ coords: FAR, method: 'face' });
    expect(res.status).toBe(400);
  });

  it('Face check-in at office → via Face', async () => {
    if (!dbReady) return;
    const res = await request(app).post('/api/attendance/check-in').set(auth(await tok(ROHAN))).send({ coords: AMD, method: 'face' });
    expect(res.status).toBe(200);
    expect(res.body.via).toBe('Face');
    expect(res.body.faceVerified).toBe(true);
  });

  it('GET /me reflects the check-in; double check-in → 400', async () => {
    if (!dbReady) return;
    const t = await tok(ROHAN);
    await request(app).post('/api/attendance/check-in').set(auth(t)).send({ coords: AMD });
    const me = await request(app).get('/api/attendance/me').set(auth(t));
    expect(me.body.inTime).toBeTruthy();
    expect(me.body.via).toBe('Geofence');
    const again = await request(app).post('/api/attendance/check-in').set(auth(t)).send({ coords: AMD });
    expect(again.status).toBe(400); // already checked in
  });

  it('check-out sets outTime', async () => {
    if (!dbReady) return;
    const t = await tok(ROHAN);
    await request(app).post('/api/attendance/check-in').set(auth(t)).send({ coords: AMD });
    const out = await request(app).post('/api/attendance/check-out').set(auth(t)).send({});
    expect(out.status).toBe(200);
    expect(out.body.outTime).toBeTruthy();
  });

  it('check-out before check-in → 400', async () => {
    if (!dbReady) return;
    const out = await request(app).post('/api/attendance/check-out').set(auth(await tok(ROHAN))).send({});
    expect(out.status).toBe(400);
  });

  it('GET /team: Super sees 7 dashboard rows; Employee → 403', async () => {
    if (!dbReady) return;
    const sup = await request(app).get('/api/attendance/team').set(auth(await tok(SUPER)));
    expect(sup.status).toBe(200);
    expect(sup.body.length).toBe(7);
    expect(sup.body.some((m: { name: string }) => m.name === 'Farhan Aga')).toBe(true);

    const emp = await request(app).get('/api/attendance/team').set(auth(await tok(ROHAN)));
    expect(emp.status).toBe(403);
  });

  it('GET /me without auth → 401', async () => {
    if (!dbReady) return;
    expect((await request(app).get('/api/attendance/me')).status).toBe(401);
  });
});
