import { connectMongo, disconnectMongo, appDb } from '../../connection';
import { attendanceService, geofenceExitStillInside, resolveCheckOutAt, resolveAutoCloseAt, teamScope, superUserIds, GEOFENCE_EXIT_BUFFER_M } from '../attendance.service';
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
  // Same stripping trap for exitAt: if it isn't in the schema, validate() drops it and check-out
  // back-dating silently dies (every checkout reverts to punch-arrival time).
  it('keeps a valid ISO exitAt after parsing', () => {
    const parsed = punchSchema.parse({ method: 'auto', source: 'geofence', exitAt: '2026-07-29T12:35:00.000Z' });
    expect(parsed.exitAt).toBe('2026-07-29T12:35:00.000Z');
  });
  it('rejects a non-ISO exitAt', () => {
    expect(punchSchema.safeParse({ exitAt: 'yesterday evening' }).success).toBe(false);
  });
});

// Check-out back-dating: the recorded out time must be when the person LEFT (the OS Exit instant
// the client persisted), not when the punch finally reached the server — but only inside hard
// bounds, so a bad clock or a spoofed client can't rewrite history.
describe('resolveCheckOutAt (check-out back-dating, pure)', () => {
  const IN = new Date('2026-07-29T05:32:00.000Z'); // 11:02 AM IST
  const EXIT = new Date('2026-07-29T12:35:00.000Z'); // 6:05 PM IST — when the OS saw the departure
  const NOW = new Date('2026-07-29T14:30:00.000Z'); // 8:00 PM IST — when the punch finally landed

  it('geofence punch with a valid exitAt → stamped at the exit instant, not arrival (the 1–2 h late-checkout fix)', () => {
    expect(resolveCheckOutAt({ source: 'geofence', exitAt: EXIT.toISOString() }, IN, NOW)).toEqual(EXIT);
  });
  it('no exitAt, or a non-geofence (manual/face) punch → arrival time', () => {
    expect(resolveCheckOutAt({ source: 'geofence' }, IN, NOW)).toEqual(NOW);
    expect(resolveCheckOutAt({ exitAt: EXIT.toISOString() }, IN, NOW)).toEqual(NOW);
  });
  it('unparseable or future exitAt → distrusted, arrival time', () => {
    expect(resolveCheckOutAt({ source: 'geofence', exitAt: 'garbage' }, IN, NOW)).toEqual(NOW);
    expect(resolveCheckOutAt({ source: 'geofence', exitAt: '2026-07-29T15:00:00.000Z' }, IN, NOW)).toEqual(NOW);
  });
  it('exitAt at or before today\'s check-in → stale drift marker, arrival time', () => {
    expect(resolveCheckOutAt({ source: 'geofence', exitAt: IN.toISOString() }, IN, NOW)).toEqual(NOW);
    expect(resolveCheckOutAt({ source: 'geofence', exitAt: '2026-07-29T05:00:00.000Z' }, IN, NOW)).toEqual(NOW);
    expect(resolveCheckOutAt({ source: 'geofence', exitAt: EXIT.toISOString() }, null, NOW)).toEqual(NOW);
  });
  it('exitAt from a previous business day (IST) → distrusted, arrival time', () => {
    // 6:30 PM IST on 07-28 vs a punch landing 07-29 — must not close today at yesterday's instant.
    expect(resolveCheckOutAt({ source: 'geofence', exitAt: '2026-07-28T13:00:00.000Z' }, new Date('2026-07-28T05:00:00.000Z'), NOW)).toEqual(NOW);
  });
});

// Attendance marking: (1) pure drift guard for geofence exits, (2) DB-backed re-entry state
// machine using a SYNTHETIC user id (no offices configured → punches allowed unverified; no real
// user's record is touched). Self-skips (like the chat realtime suite) when Mongo isn't reachable.

const OFFICE = { lat: 19.1466, lng: 72.8293, radius: 100 };
// ~0.00045° latitude ≈ 50 m; inside/outside points derived from the office anchor.
const at = (dLatM: number) => ({ lat: OFFICE.lat + dLatM / 111_320, lng: OFFICE.lng });

const WIFI_OFFICE = { ...OFFICE, wifiSsid: 'Office 5G' };

describe('geofenceExitStillInside (drift guard, pure — strict Wi-Fi + geofence)', () => {
  it('geofence-only office: fix inside the radius → still inside (the 82 m drift case)', () => {
    expect(geofenceExitStillInside([OFFICE], at(82), false)).toBe(true);
  });
  it('geofence-only office: fix within radius + buffer hysteresis → still inside', () => {
    expect(geofenceExitStillInside([OFFICE], at(OFFICE.radius + GEOFENCE_EXIT_BUFFER_M - 5), false)).toBe(true);
  });
  it('fix clearly beyond radius + buffer → genuinely left, even on office Wi-Fi (strict)', () => {
    expect(geofenceExitStillInside([OFFICE], at(OFFICE.radius + GEOFENCE_EXIT_BUFFER_M + 40), false)).toBe(false);
    expect(geofenceExitStillInside([WIFI_OFFICE], at(OFFICE.radius + GEOFENCE_EXIT_BUFFER_M + 40), true)).toBe(false);
  });
  it('SSID-configured office: drift fix inside needs the Wi-Fi leg too', () => {
    expect(geofenceExitStillInside([WIFI_OFFICE], at(82), true)).toBe(true); // both legs hold → drift
    expect(geofenceExitStillInside([WIFI_OFFICE], at(82), false)).toBe(false); // Wi-Fi broke → exit stands
  });
  it('no fix: office Wi-Fi anchors them on-site; without it the exit stands', () => {
    expect(geofenceExitStillInside([WIFI_OFFICE], null, true)).toBe(true);
    expect(geofenceExitStillInside([WIFI_OFFICE], null, false)).toBe(false);
  });
  it('no offices → not provable, exit stands', () => {
    expect(geofenceExitStillInside([], at(0), false)).toBe(false);
  });
});

// Branch-wise team view: who sees whom (pure). A leaked branch here = one branch's attendance
// visible to another branch's manager, so every role tier is pinned.
describe('teamScope (team-view branch scoping, pure)', () => {
  const v = (o: Partial<Parameters<typeof teamScope>[0]>) =>
    teamScope({ canManage: false, companyWide: false, level: 5, branchIds: [], ...o });

  it('super_admin / company_manager → the whole tenant, unnarrowed', () => {
    expect(v({ canManage: true, companyWide: true, level: 1, branchIds: null })).toEqual({ seesTeam: true, branchIds: null });
    expect(v({ canManage: true, companyWide: true, level: 2, branchIds: null })).toEqual({ seesTeam: true, branchIds: null });
  });
  it('branch_manager → their own branches only', () => {
    expect(v({ level: 3, branchIds: ['bom', 'amd'] })).toEqual({ seesTeam: true, branchIds: ['bom', 'amd'] });
  });
  it('branch_manager with no branches → self only (never the whole tenant)', () => {
    expect(v({ level: 3, branchIds: [] })).toEqual({ seesTeam: false, branchIds: null });
    expect(v({ level: 3, branchIds: null })).toEqual({ seesTeam: false, branchIds: null });
  });
  it('hod / employee → self only, whatever branches they hold', () => {
    expect(v({ level: 4, branchIds: ['bom'] })).toEqual({ seesTeam: false, branchIds: null });
    expect(v({ level: 5, branchIds: ['bom'] })).toEqual({ seesTeam: false, branchIds: null });
  });
  it('a manager flagged canManage but not companyWide is still narrowed', () => {
    expect(v({ canManage: true, companyWide: false, level: 2, branchIds: ['nbo'] })).toEqual({ seesTeam: true, branchIds: ['nbo'] });
  });
});

// Super-admins are never attendance-tracked: no punches, hidden from team view and day-close.
describe('superUserIds (supers are untracked, pure)', () => {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const roles = [
    { _id: 'r-super', level: 1, permissions: [] },
    { _id: 'r-star', level: 4, permissions: ['*'] }, // '*' permission = super regardless of level
    { _id: 'r-mgr', level: 2, permissions: [] },
    { _id: 'r-emp', level: 5 },
  ];
  const users = [
    { _id: 'dev', role_id: 'r-super' },
    { _id: 'wild', role_id: 'r-star' },
    { _id: 'mgr', role_id: 'r-mgr' },
    { _id: 'emp', role_id: 'r-emp' },
    { _id: 'norole', role_id: null },
  ] as any[];

  it('flags level-1 and "*"-permission roles, nobody else', () => {
    expect([...superUserIds(users, roles as any)].sort()).toEqual(['dev', 'wild']);
  });
  it('a user with no role is tracked (defaults to employee)', () => {
    expect(superUserIds(users, roles as any).has('norole')).toBe(false);
  });
  /* eslint-enable @typescript-eslint/no-explicit-any */
});

describe('resolveAutoCloseAt (forgotten-checkout stamp, pure)', () => {
  const day = '2026-07-31';
  it('normal day: closes at the 7pm business-time stamp, not the 10pm sweep hour', () => {
    const checkIn = new Date('2026-07-31T04:30:00.000Z'); // 10:00 IST
    const out = resolveAutoCloseAt(day, checkIn);
    expect(out.toISOString()).toBe('2026-07-31T13:30:00.000Z'); // 19:00 IST
  });
  it('checked in AFTER 7pm: closes at the check-in instant (never before the check-in)', () => {
    const checkIn = new Date('2026-07-31T14:30:00.000Z'); // 20:00 IST
    expect(resolveAutoCloseAt(day, checkIn).toISOString()).toBe(checkIn.toISOString());
  });
  it('honours a custom stamp time', () => {
    const checkIn = new Date('2026-07-31T04:30:00.000Z');
    expect(resolveAutoCloseAt(day, checkIn, '18:00').toISOString()).toBe('2026-07-31T12:30:00.000Z'); // 18:00 IST
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
    const opened = await attendanceService.checkIn(FAKE_USER, { coords: null, facePhotoUrl: 'test://face.jpg' });
    expect(opened.inTime).toBeTruthy();
    expect(opened.present).toBe(true);
    const firstIn = opened.inTime;

    await expect(attendanceService.checkIn(FAKE_USER, { coords: null, facePhotoUrl: 'test://face.jpg' })).rejects.toThrow('Already checked in');

    const closed = await attendanceService.checkOut(FAKE_USER, { coords: null, facePhotoUrl: 'test://face.jpg' });
    expect(closed.outTime).toBeTruthy();
    expect(closed.present).toBe(false);

    const reopened = await attendanceService.checkIn(FAKE_USER, { coords: null, facePhotoUrl: 'test://face.jpg' });
    expect(reopened.present).toBe(true);
    expect(reopened.outTime).toBeNull(); // the spurious/previous check-out is cleared
    expect(reopened.inTime).toBe(firstIn); // original first-in preserved

    const closedAgain = await attendanceService.checkOut(FAKE_USER, { coords: null, facePhotoUrl: 'test://face.jpg' });
    expect(closedAgain.outTime).toBeTruthy(); // last-out wins
  }, 30000);
});
