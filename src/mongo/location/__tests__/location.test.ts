import { connectMongo, disconnectMongo, appDb } from '../../connection';
import { attendanceRepo } from '../../attendance/attendance.repository';
import { dayKeyIn } from '../../attendance/attendanceBranch';
import { pingsSchema } from '../location.router';
import { locationService, selectPings, WINDOW_BEFORE_CHECK_IN_MS, WINDOW_FUTURE_MS } from '../location.service';
import { ensureLocationIndexes, LocationLastModel, LocationPingModel } from '../location.model';

describe('pingsSchema (validate() strips unknown keys — every read field must survive)', () => {
  it('keeps accuracy, speed, heading, altitude and source', () => {
    const parsed = pingsSchema.parse({ pings: [{ at: '2026-10-05T04:30:00.000Z', lat: 19.07, lng: 72.87, accuracy: 8, speed: 1.2, heading: 90, altitude: 12, source: 'bg' }] });
    expect(parsed.pings[0]).toEqual({ at: '2026-10-05T04:30:00.000Z', lat: 19.07, lng: 72.87, accuracy: 8, speed: 1.2, heading: 90, altitude: 12, source: 'bg' });
  });
  it('rejects an empty batch, an oversized batch, a bad instant and an out-of-range coordinate', () => {
    expect(pingsSchema.safeParse({ pings: [] }).success).toBe(false);
    expect(pingsSchema.safeParse({ pings: Array.from({ length: 501 }, () => ({ at: '2026-10-05T04:30:00.000Z', lat: 1, lng: 1 })) }).success).toBe(false);
    expect(pingsSchema.safeParse({ pings: [{ at: 'this morning', lat: 1, lng: 1 }] }).success).toBe(false);
    expect(pingsSchema.safeParse({ pings: [{ at: '2026-10-05T04:30:00.000Z', lat: 91, lng: 1 }] }).success).toBe(false);
  });
  it('rejects an unknown source', () => {
    expect(pingsSchema.safeParse({ pings: [{ at: '2026-10-05T04:30:00.000Z', lat: 1, lng: 1, source: 'spoofed' }] }).success).toBe(false);
  });
});

describe('selectPings (what of a device batch is worth storing)', () => {
  const checkInAt = new Date('2026-10-05T04:30:00.000Z'); // 10:00 IST
  const now = new Date('2026-10-05T07:00:00.000Z');
  const win = { checkInAt, now };
  const at = (ms: number): string => new Date(ms).toISOString();

  it('keeps fixes inside the open day window, in time order, deduplicated by instant', () => {
    const out = selectPings([
      { at: at(now.getTime() - 60_000), lat: 19.1, lng: 72.9, accuracy: 10 },
      { at: at(checkInAt.getTime() + 60_000), lat: 19.0, lng: 72.8, accuracy: 5 },
      { at: at(checkInAt.getTime() + 60_000), lat: 19.0, lng: 72.8, accuracy: 5 }, // re-sent
    ], win);
    expect(out.map((p) => p.at.toISOString())).toEqual([at(checkInAt.getTime() + 60_000), at(now.getTime() - 60_000)]);
  });
  it('drops fixes from before the check-in (beyond the grace) and from the future', () => {
    const out = selectPings([
      { at: at(checkInAt.getTime() - WINDOW_BEFORE_CHECK_IN_MS - 1), lat: 19, lng: 72 },
      { at: at(checkInAt.getTime() - WINDOW_BEFORE_CHECK_IN_MS + 1), lat: 19, lng: 72 },
      { at: at(now.getTime() + WINDOW_FUTURE_MS + 1), lat: 19, lng: 72 },
    ], win);
    expect(out).toHaveLength(1);
  });
  it('drops inaccurate fixes but keeps ones with unknown accuracy', () => {
    const out = selectPings([
      { at: at(now.getTime() - 1000), lat: 19, lng: 72, accuracy: 900 },
      { at: at(now.getTime() - 2000), lat: 19, lng: 72, accuracy: null },
      { at: at(now.getTime() - 3000), lat: 19, lng: 72 },
    ], win, 250);
    expect(out).toHaveLength(2);
    expect(out.every((p) => p.accuracy === null)).toBe(true);
  });
  it('drops non-finite or out-of-range coordinates and normalises optional fields', () => {
    const out = selectPings([
      { at: at(now.getTime() - 1000), lat: Number.NaN, lng: 72 },
      { at: at(now.getTime() - 2000), lat: 19, lng: 181 },
      { at: at(now.getTime() - 3000), lat: 19, lng: 72, speed: Number.NaN, heading: undefined, source: 'fg' },
    ], win);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ speed: null, heading: null, altitude: null, source: 'fg' });
  });
  it('on a closed day keeps only fixes taken up to the check-out (the post-check-out flush)', () => {
    const checkOutAt = new Date('2026-10-05T06:00:00.000Z');
    const out = selectPings([
      { at: at(checkOutAt.getTime() - 1000), lat: 19, lng: 72 },
      { at: at(checkOutAt.getTime() + 1000), lat: 19, lng: 72 },
    ], { checkInAt, checkOutAt, now });
    expect(out.map((p) => p.at.getTime())).toEqual([checkOutAt.getTime() - 1000]);
  });
  it('treats an unknown source as background', () => {
    const [p] = selectPings([{ at: at(now.getTime() - 1000), lat: 19, lng: 72, source: 'weird' as 'bg' }], win);
    expect(p.source).toBe('bg');
  });
});

// ── DB-backed ingest (skipped when no Mongo is reachable, like the attendance suite) ──
let ready = false;
const FAKE_USER = `jest-trail-${Date.now().toString(36)}`;
const FAKE_IDLE = `${FAKE_USER}-idle`; // never checks in
const todayKey = dayKeyIn(process.env.ATTENDANCE_TZ || 'Asia/Kolkata');

beforeAll(async () => {
  try {
    await connectMongo();
    await ensureLocationIndexes(); // the unique (userId, at) index is what makes a re-send idempotent
    ready = true;
  } catch {
    ready = false;
  }
}, 40000);

afterAll(async () => {
  if (ready) {
    const ids = { $in: [FAKE_USER, FAKE_IDLE] };
    await LocationPingModel().deleteMany({ userId: ids });
    await LocationLastModel().deleteMany({ userId: ids });
    /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
    await (appDb().collection('attendance') as any).deleteMany({ userId: ids });
  }
  await disconnectMongo();
}, 20000);

describe('ingest (DB): only an open attendance day is trailed; the server tells the device when to stop', () => {
  const now = Date.now();
  const iso = (agoMs: number): string => new Date(now - agoMs).toISOString();

  it('refuses everything for someone who has not checked in today', async () => {
    if (!ready) return;
    expect(await locationService.ingest(FAKE_IDLE, [{ at: iso(1000), lat: 19, lng: 72 }])).toEqual({ accepted: 0, tracking: false });
    expect(await LocationPingModel().countDocuments({ userId: FAKE_IDLE })).toBe(0);
  }, 30000);

  it('stores an open day, is idempotent on a re-send, and tracks the newest fix as last-known', async () => {
    if (!ready) return;
    await attendanceRepo.upsert(FAKE_USER, todayKey, { date: new Date(`${todayKey}T00:00:00.000Z`), checkInAt: new Date(now - 60 * 60_000), checkOutAt: null, present: true });
    const batch = [
      { at: iso(30 * 60_000), lat: 19.0701, lng: 72.8701, accuracy: 6 },
      { at: iso(20 * 60_000), lat: 19.0702, lng: 72.8702, accuracy: 7 },
      { at: iso(10 * 60_000), lat: 19.0703, lng: 72.8703, accuracy: 8 },
    ];
    expect(await locationService.ingest(FAKE_USER, batch)).toEqual({ accepted: 3, tracking: true });
    // The device retries after a dropped response: same instants plus one new fix.
    expect(await locationService.ingest(FAKE_USER, [...batch, { at: iso(5 * 60_000), lat: 19.0704, lng: 72.8704, accuracy: 5 }])).toEqual({ accepted: 1, tracking: true });
    expect(await LocationPingModel().countDocuments({ userId: FAKE_USER, dateKey: todayKey })).toBe(4);
    const last = await LocationLastModel().findOne({ userId: FAKE_USER }).lean();
    expect(last?.lat).toBe(19.0704);
    expect(last?.dateKey).toBe(todayKey);
  }, 30000);

  it('a late-arriving OLDER batch is stored but never rewinds last-known', async () => {
    if (!ready) return;
    expect(await locationService.ingest(FAKE_USER, [{ at: iso(25 * 60_000), lat: 19.09, lng: 72.89 }])).toEqual({ accepted: 1, tracking: true });
    const last = await LocationLastModel().findOne({ userId: FAKE_USER }).lean();
    expect(last?.lat).toBe(19.0704);
    expect(await LocationLastModel().countDocuments({ userId: FAKE_USER })).toBe(1);
  }, 30000);

  it('after check-out: keeps fixes taken on duty, drops later ones, and answers tracking:false', async () => {
    if (!ready) return;
    await attendanceRepo.upsert(FAKE_USER, todayKey, { checkOutAt: new Date(now - 2 * 60_000), present: false });
    const out = await locationService.ingest(FAKE_USER, [
      { at: iso(3 * 60_000), lat: 19.0705, lng: 72.8705 }, // before the check-out — part of the day
      { at: iso(60_000), lat: 19.2, lng: 72.9 }, // after it — the person is off duty
    ]);
    expect(out).toEqual({ accepted: 1, tracking: false });
    expect(await LocationPingModel().countDocuments({ userId: FAKE_USER, lat: 19.2 })).toBe(0);
  }, 30000);
});
