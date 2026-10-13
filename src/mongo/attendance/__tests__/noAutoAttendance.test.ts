import { connectMongo, disconnectMongo, appDb } from '../../connection';
import { attendanceService } from '../attendance.service';

// No automatic attendance for staff (owner, 2026-10-13 — reverses the 10-05 "fully automatic"
// decision). Phones that still run the old automatic engine keep posting `method:'auto'` punches
// with no photo; the server must refuse every one of them. The manual face-photo punch is unchanged.

// ── DB-backed (skipped when no Mongo is reachable) ──
let ready = false;
const FAKE_USER = `jest-noauto-${Date.now().toString(36)}`; // unknown to the CRM → no office, not hidden

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

describe('automatic punches are refused; the manual photo punch is unchanged', () => {
  it('refuses an automatic check-in (no photo) and records nothing', async () => {
    if (!ready) return;
    await expect(attendanceService.checkIn(FAKE_USER, { method: 'auto', source: 'geofence', coords: { lat: 19.076, lng: 72.8777 } })).rejects.toThrow('A face photo is required to check in');
    await expect(attendanceService.checkIn(FAKE_USER, { method: 'auto', coords: { lat: 19.076, lng: 72.8777 }, wifiSsid: 'Office' })).rejects.toThrow('A face photo is required to check in');
    const me = await attendanceService.me(FAKE_USER);
    expect(me.inTime).toBeNull();
  }, 30000);

  it('a manual check-in works; an automatic check-out is refused and leaves the day open; a manual check-out closes it', async () => {
    if (!ready) return;
    const opened = await attendanceService.checkIn(FAKE_USER, { method: 'face', coords: null, facePhotoUrl: 'test://face.jpg' });
    expect(opened.inTime).toBeTruthy();
    expect(opened.via).toBe('Face');
    await expect(attendanceService.checkOut(FAKE_USER, { method: 'auto', source: 'geofence', coords: { lat: 20, lng: 73 }, exitAt: new Date().toISOString() })).rejects.toThrow('A face photo is required to check out');
    const still = await attendanceService.me(FAKE_USER);
    expect(still.outTime).toBeNull();
    const closed = await attendanceService.checkOut(FAKE_USER, { method: 'face', coords: null, facePhotoUrl: 'test://face.jpg' });
    expect(closed.outTime).toBeTruthy();
  }, 30000);
});
