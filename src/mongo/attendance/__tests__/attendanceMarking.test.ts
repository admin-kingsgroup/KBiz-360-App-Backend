import { connectMongo, disconnectMongo, appDb } from '../../connection';
import { attendanceService, geofenceExitStillInside, GEOFENCE_EXIT_BUFFER_M } from '../attendance.service';
import { punchSchema } from '../attendance.router';

// Regression: validate() replaces req.body with the parsed schema, dropping unknown keys. If
// `source` isn't in the schema it is stripped before checkOut runs and the drift guard is dead.
describe('punchSchema preserves source (drift-guard regression)', () => {
  it('keeps source:"geofence" after parsing', () => {
    const parsed = punchSchema.parse({ method: 'auto', coords: { lat: 19.1, lng: 72.8 }, source: 'geofence' });
    expect(parsed.source).toBe('geofence');
  });
  it('rejects an unknown source value', () => {
    expect(punchSchema.safeParse({ source: 'spoofed' }).success).toBe(false);
  });
});

// Attendance marking: (1) pure drift guard for geofence exits, (2) DB-backed re-entry state
// machine using a SYNTHETIC user id (no offices configured → punches allowed unverified; no real
// user's record is touched). Self-skips (like the chat realtime suite) when Mongo isn't reachable.

const OFFICE = { lat: 19.1466, lng: 72.8293, radius: 100 };
// ~0.00045° latitude ≈ 50 m; inside/outside points derived from the office anchor.
const at = (dLatM: number) => ({ lat: OFFICE.lat + dLatM / 111_320, lng: OFFICE.lng });

describe('geofenceExitStillInside (drift guard, pure)', () => {
  it('fix inside the radius → still inside (the 82 m drift case)', () => {
    expect(geofenceExitStillInside([OFFICE], at(82), false)).toBe(true);
  });
  it('fix within radius + buffer hysteresis → still inside', () => {
    expect(geofenceExitStillInside([OFFICE], at(OFFICE.radius + GEOFENCE_EXIT_BUFFER_M - 5), false)).toBe(true);
  });
  it('fix clearly beyond radius + buffer → genuinely left', () => {
    expect(geofenceExitStillInside([OFFICE], at(OFFICE.radius + GEOFENCE_EXIT_BUFFER_M + 40), false)).toBe(false);
  });
  it('office Wi-Fi match overrides any coords', () => {
    expect(geofenceExitStillInside([OFFICE], at(500), true)).toBe(true);
  });
  it('no offices / no coords → not provable, exit stands', () => {
    expect(geofenceExitStillInside([], at(0), false)).toBe(false);
    expect(geofenceExitStillInside([OFFICE], null, false)).toBe(false);
  });
});

// ── DB-backed re-entry state machine ──
let ready = false;
const FAKE_USER = `jest-att-${Date.now().toString(36)}`;

beforeAll(async () => {
  try {
    await connectMongo();
    ready = true;
  } catch {
    ready = false;
  }
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

describe('check-in / check-out re-entry model (first-in stays, last-out wins)', () => {
  it('open → duplicate check-in rejected → check-out closes → check-in RE-OPENS preserving first-in', async () => {
    if (!ready) return;
    const opened = await attendanceService.checkIn(FAKE_USER, { coords: null });
    expect(opened.inTime).toBeTruthy();
    expect(opened.present).toBe(true);
    const firstIn = opened.inTime;

    await expect(attendanceService.checkIn(FAKE_USER, { coords: null })).rejects.toThrow('Already checked in');

    const closed = await attendanceService.checkOut(FAKE_USER, { coords: null });
    expect(closed.outTime).toBeTruthy();
    expect(closed.present).toBe(false);

    const reopened = await attendanceService.checkIn(FAKE_USER, { coords: null });
    expect(reopened.present).toBe(true);
    expect(reopened.outTime).toBeNull(); // the spurious/previous check-out is cleared
    expect(reopened.inTime).toBe(firstIn); // original first-in preserved

    const closedAgain = await attendanceService.checkOut(FAKE_USER, { coords: null });
    expect(closedAgain.outTime).toBeTruthy(); // last-out wins
  }, 30000);
});
