import { connectMongo, disconnectMongo, appDb } from '../../connection';
import { attendanceService, autoMayOpenDay, trailExitSince, AUTO_OUT_DWELL_MS, AUTO_OUT_MAX_ACCURACY_M } from '../attendance.service';

// Fully automatic attendance (owner decision, 2026-10-05): the phone checks people in on arrival
// and out on departure with no photo; the manual face punch stays as the fallback.

describe('autoMayOpenDay — may an automatic check-in open or re-open the day?', () => {
  const at = (h: number): Date => new Date(Date.UTC(2026, 9, 5, h));
  it('opens a day with no check-in yet', () => {
    expect(autoMayOpenDay(null)).toBe(true);
    expect(autoMayOpenDay({ checkInAt: null, checkOutAt: null, method: null })).toBe(true);
  });
  it('does nothing to a day that is already open', () => {
    expect(autoMayOpenDay({ checkInAt: at(4), checkOutAt: null, method: 'Geofence' })).toBe(false);
  });
  it('re-opens a day the phone closed (stepped out for lunch, or GPS drift)', () => {
    expect(autoMayOpenDay({ checkInAt: at(4), checkOutAt: at(8), method: 'Geofence' })).toBe(true);
    expect(autoMayOpenDay({ checkInAt: at(4), checkOutAt: at(8), method: 'Wi-Fi' })).toBe(true);
    expect(autoMayOpenDay({ checkInAt: at(4), checkOutAt: at(8), method: 'Auto' })).toBe(true);
  });
  it('NEVER re-opens a day the person closed by hand, or an admin corrected', () => {
    expect(autoMayOpenDay({ checkInAt: at(4), checkOutAt: at(8), method: 'Face' })).toBe(false);
    expect(autoMayOpenDay({ checkInAt: at(4), checkOutAt: at(8), method: 'Manual' })).toBe(false);
  });
});

describe('trailExitSince — has the live trail proven the person left the office?', () => {
  const office = { lat: 19.076, lng: 72.8777, radius: 100 };
  const T0 = Date.parse('2026-10-05T08:00:00.000Z');
  // ~111 m per 0.001° of latitude.
  const fix = (minutes: number, metresNorth: number, accuracy: number | null = 8) =>
    ({ at: new Date(T0 + minutes * 60_000), lat: office.lat + metresNorth / 111_320, lng: office.lng, accuracy });

  it('says no while the person is inside', () => {
    expect(trailExitSince([fix(0, 10), fix(2, 20), fix(4, 30), fix(6, 15)], [office])).toBeNull();
  });
  it('says yes once enough accurate fixes sit outside for the dwell time, stamped at the FIRST outside fix', () => {
    const out = trailExitSince([fix(0, 20), fix(1, 150), fix(3, 300), fix(5, 600), fix(6, 800)], [office]);
    expect(out?.leftAt.getTime()).toBe(T0 + 60_000);
    expect(out?.last.lat).toBeCloseTo(fix(6, 800).lat);
  });
  it('waits when the outside run is too short in time or in count', () => {
    expect(trailExitSince([fix(0, 20), fix(1, 150), fix(2, 300), fix(3, 600)], [office])).toBeNull(); // 2 min < dwell
    expect(trailExitSince([fix(0, 20), fix(1, 400), fix(1 + AUTO_OUT_DWELL_MS / 60_000 + 1, 900)], [office])).toBeNull(); // only 2 fixes
  });
  it('a fix back inside breaks the run (walked past the boundary and returned)', () => {
    expect(trailExitSince([fix(0, 150), fix(3, 300), fix(6, 400), fix(7, 20)], [office])).toBeNull();
    // …and the run restarts after it.
    expect(trailExitSince([fix(0, 150), fix(3, 300), fix(6, 20), fix(7, 150), fix(9, 300), fix(12, 500)], [office])?.leftAt.getTime()).toBe(T0 + 7 * 60_000);
  });
  it('a fix that cannot clear the fence by its own error does not count as outside', () => {
    // 130 m away ±40 m could still be inside a 100 m fence.
    expect(trailExitSince([fix(0, 130, 40), fix(3, 130, 40), fix(6, 130, 40)], [office])).toBeNull();
    // Too blurry to trust at all, however far.
    expect(trailExitSince([fix(0, 5000, AUTO_OUT_MAX_ACCURACY_M + 1), fix(3, 5000, AUTO_OUT_MAX_ACCURACY_M + 1), fix(6, 5000, AUTO_OUT_MAX_ACCURACY_M + 1)], [office])).toBeNull();
  });
  it('must be outside EVERY office the person may report to', () => {
    const second = { lat: office.lat + 600 / 111_320, lng: office.lng, radius: 100 };
    expect(trailExitSince([fix(0, 560), fix(3, 600), fix(6, 640)], [office, second])).toBeNull(); // at the second office
    expect(trailExitSince([fix(0, 1500), fix(3, 1600), fix(6, 1700)], [office, second])).not.toBeNull();
  });
  it('never fires without an office or without fixes; order of the input does not matter', () => {
    expect(trailExitSince([fix(0, 900), fix(3, 900), fix(6, 900)], [])).toBeNull();
    expect(trailExitSince([], [office])).toBeNull();
    expect(trailExitSince([fix(6, 800), fix(1, 150), fix(3, 300)], [office])?.leftAt.getTime()).toBe(T0 + 60_000);
  });
});

// ── DB-backed (skipped when no Mongo is reachable) ──
let ready = false;
const FAKE_USER = `jest-auto-${Date.now().toString(36)}`; // unknown to the CRM → no office

beforeAll(async () => {
  try { await connectMongo(); ready = true; } catch { ready = false; }
}, 40000);
afterAll(async () => {
  if (ready) {
    /* eslint-disable @typescript-eslint/no-explicit-any */
    await (appDb().collection('attendance') as any).deleteMany({ userId: FAKE_USER });
    await (appDb().collection('alert_events') as any).deleteMany({ recipients: FAKE_USER });
    /* eslint-enable @typescript-eslint/no-explicit-any */
  }
  await disconnectMongo();
}, 20000);

describe('automatic punches are held to a real office; the manual photo punch is unchanged', () => {
  it('refuses an automatic check-in for an account with no office, and still demands a photo for a manual one', async () => {
    if (!ready) return;
    await expect(attendanceService.checkIn(FAKE_USER, { method: 'auto', source: 'geofence', coords: { lat: 19.076, lng: 72.8777 } })).rejects.toThrow('No office location');
    await expect(attendanceService.checkIn(FAKE_USER, { method: 'face', coords: null })).rejects.toThrow('A face photo is required');
  }, 30000);

  it('a manual check-in works as before; an automatic check-out without an office is refused; a manual check-out closes it; automatic check-in will not re-open it', async () => {
    if (!ready) return;
    const opened = await attendanceService.checkIn(FAKE_USER, { method: 'face', coords: null, facePhotoUrl: 'test://face.jpg' });
    expect(opened.inTime).toBeTruthy();
    await expect(attendanceService.checkOut(FAKE_USER, { method: 'auto', source: 'geofence', coords: { lat: 20, lng: 73 } })).rejects.toThrow('No office location');
    const closed = await attendanceService.checkOut(FAKE_USER, { method: 'face', coords: null, facePhotoUrl: 'test://face.jpg' });
    expect(closed.outTime).toBeTruthy();
    await expect(attendanceService.checkIn(FAKE_USER, { method: 'auto', source: 'geofence', coords: { lat: 19.076, lng: 72.8777 } })).rejects.toThrow('You checked out yourself');
  }, 30000);
});
