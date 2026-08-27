import { connectMongo, disconnectMongo, appDb } from '../../connection';
import { attendanceService, geofenceExitStillInside, resolveCheckOutAt, resolveAdminTimes, resolveAutoCloseAt, branchAutoClose, autoCloseDue, teamScope, superUserIds, GEOFENCE_EXIT_BUFFER_M } from '../attendance.service';
import { punchSchema, adminTimesSchema } from '../attendance.router';

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

// Admin time correction (PUT /attendance/admin/day/times): the one path that can rewrite a day's
// times, so its bounds are pinned like exitAt's. IST is the row's calendar (ATTENDANCE_TZ default).
describe('adminTimesSchema (admin time-correction body)', () => {
  const base = { userId: 'u1', date: '2026-08-27', checkInAt: '2026-08-27T04:10:00.000Z' };
  it('keeps checkOutAt:null — an explicit "still in" must survive validate()', () => {
    expect(adminTimesSchema.parse({ ...base, checkOutAt: null }).checkOutAt).toBeNull();
  });
  it('rejects a wall-clock string where an ISO instant is expected', () => {
    expect(adminTimesSchema.safeParse({ ...base, checkInAt: '09:40' }).success).toBe(false);
    expect(adminTimesSchema.safeParse({ ...base, checkOutAt: '19:00' }).success).toBe(false);
  });
});

describe('resolveAdminTimes (admin time-correction bounds, pure)', () => {
  const NOW = new Date('2026-08-27T10:00:00.000Z'); // 3:30 PM IST, 27 Aug
  const today = '2026-08-27';
  const IN = '2026-08-27T04:10:00.000Z'; // 9:40 AM IST
  const OUT = '2026-08-27T09:00:00.000Z'; // 2:30 PM IST

  it('valid in/out on the day → exactly the instants given', () => {
    const r = resolveAdminTimes({ date: today, checkInAt: IN, checkOutAt: OUT }, NOW);
    expect(r.checkInAt.toISOString()).toBe(IN);
    expect(r.checkOutAt?.toISOString()).toBe(OUT);
  });
  it('today may be left open (no check-out); a past day may not', () => {
    expect(resolveAdminTimes({ date: today, checkInAt: IN }, NOW).checkOutAt).toBeNull();
    expect(resolveAdminTimes({ date: today, checkInAt: IN, checkOutAt: null }, NOW).checkOutAt).toBeNull();
    expect(() => resolveAdminTimes({ date: '2026-08-26', checkInAt: '2026-08-26T04:10:00.000Z', checkOutAt: null }, NOW)).toThrow('past day');
  });
  it('the times must fall on the business day being corrected (IST calendar, the row key)', () => {
    // 11:30 PM IST on the 26th belongs to the 26th's row, never the 27th's.
    expect(() => resolveAdminTimes({ date: today, checkInAt: '2026-08-26T18:00:00.000Z', checkOutAt: OUT }, NOW)).toThrow('must fall on');
    // 2:00 AM IST on the 28th (20:30Z on the 27th) is a check-out on the wrong day too.
    expect(() => resolveAdminTimes({ date: today, checkInAt: IN, checkOutAt: '2026-08-27T20:30:00.000Z' }, new Date('2026-08-28T05:00:00.000Z'))).toThrow('must fall on');
  });
  it('rejects future instants, a check-out at/before the check-in, and unparseable input', () => {
    expect(() => resolveAdminTimes({ date: today, checkInAt: '2026-08-27T11:00:00.000Z' }, NOW)).toThrow('future');
    expect(() => resolveAdminTimes({ date: today, checkInAt: IN, checkOutAt: '2026-08-27T11:00:00.000Z' }, NOW)).toThrow('future');
    expect(() => resolveAdminTimes({ date: today, checkInAt: IN, checkOutAt: IN }, NOW)).toThrow('after check-in');
    expect(() => resolveAdminTimes({ date: today, checkInAt: 'nine forty' }, NOW)).toThrow('valid instant');
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
  it('stamps in the BRANCH timezone at the branch stamp time, not IST', () => {
    const checkIn = new Date('2026-07-31T05:30:00.000Z'); // 08:30 EAT
    const stamp = (code: string) => {
      const { tz, stamp: hhmm } = branchAutoClose({ code });
      return resolveAutoCloseAt(day, checkIn, hhmm, tz).toISOString();
    };
    expect(stamp('NBO')).toBe('2026-07-31T15:30:00.000Z'); // 18:30 EAT (UTC+3) — NBO office end
    expect(stamp('DAR')).toBe('2026-07-31T14:30:00.000Z'); // 17:30 EAT (UTC+3) — DAR office end
    expect(stamp('FBM')).toBe('2026-07-31T15:30:00.000Z'); // 17:30 CAT (UTC+2) — FBM office end
    expect(stamp('BOM')).toBe('2026-07-31T13:30:00.000Z'); // 19:00 IST — Indian default unchanged
  });
});

describe('autoCloseDue (10pm gate in the BRANCH local night, pure)', () => {
  const day = '2026-07-31';
  it('India: due exactly from 22:00 IST', () => {
    expect(autoCloseDue(day, 'Asia/Kolkata', new Date('2026-07-31T16:29:00.000Z'))).toBe(false); // 21:59 IST
    expect(autoCloseDue(day, 'Asia/Kolkata', new Date('2026-07-31T16:30:00.000Z'))).toBe(true);  // 22:00 IST
  });
  it('NBO/DAR: due from 22:00 EAT (= 00:30 IST next day), NOT from 22:00 IST', () => {
    expect(autoCloseDue(day, 'Africa/Nairobi', new Date('2026-07-31T16:30:00.000Z'))).toBe(false); // 19:30 EAT
    expect(autoCloseDue(day, 'Africa/Nairobi', new Date('2026-07-31T19:00:00.000Z'))).toBe(true);  // 22:00 EAT
  });
  it('FBM: due from 22:00 CAT (= 01:30 IST next day)', () => {
    expect(autoCloseDue(day, 'Africa/Lubumbashi', new Date('2026-07-31T19:59:00.000Z'))).toBe(false); // 21:59 CAT
    expect(autoCloseDue(day, 'Africa/Lubumbashi', new Date('2026-07-31T20:00:00.000Z'))).toBe(true);  // 22:00 CAT
  });
  it('a past day is always due (leftover cleanup on a later sweep)', () => {
    expect(autoCloseDue(day, 'Africa/Lubumbashi', new Date('2026-08-01T09:00:00.000Z'))).toBe(true);
  });
});

describe('branchAutoClose (branch code → local zone + office-end stamp)', () => {
  it('maps the African branches to their local zone and office closing time', () => {
    expect(branchAutoClose({ code: 'NBO' })).toEqual({ tz: 'Africa/Nairobi', stamp: '18:30' });
    expect(branchAutoClose({ code: 'DAR' })).toEqual({ tz: 'Africa/Dar_es_Salaam', stamp: '17:30' });
    expect(branchAutoClose({ code: 'FBM' })).toEqual({ tz: 'Africa/Lubumbashi', stamp: '17:30' });
    expect(branchAutoClose({ code: 'fbm' })).toEqual({ tz: 'Africa/Lubumbashi', stamp: '17:30' }); // case-insensitive
  });
  it('falls back to IST at 7pm for Indian/unknown/missing branches', () => {
    expect(branchAutoClose({ code: 'BOM' })).toEqual({ tz: 'Asia/Kolkata', stamp: '19:00' });
    expect(branchAutoClose({ code: 'BOMMB' })).toEqual({ tz: 'Asia/Kolkata', stamp: '19:00' });
    expect(branchAutoClose({ code: null })).toEqual({ tz: 'Asia/Kolkata', stamp: '19:00' });
    expect(branchAutoClose(null)).toEqual({ tz: 'Asia/Kolkata', stamp: '19:00' });
  });
});

// ── DB-backed re-entry state machine ──
let ready = false;
const FAKE_USER = `jest-att-${Date.now().toString(36)}`;
const FAKE_USER_NEVER = `${FAKE_USER}-never`; // never punches — the admin-times "absent → Manual" path

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
    await (appDb().collection('attendance') as any).deleteMany({ userId: { $in: [FAKE_USER, FAKE_USER_NEVER] } });
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

// Admin time correction against the DB: runs AFTER the re-entry suite, so FAKE_USER's day is a
// real (closed) punch carrying a face photo — exactly the evidence an edit must not destroy.
describe('applyAdminTimes (DB: moves the times, keeps the punch evidence, stamps adjusted)', () => {
  const ADMIN = 'jest-admin';
  const tz = process.env.ATTENDANCE_TZ || 'Asia/Kolkata';
  const keyIn = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const rawRow = (userId: string, dateKey: string) => (appDb().collection('attendance') as any).findOne({ userId, dateKey });
  /* eslint-enable @typescript-eslint/no-explicit-any */

  it('a real punch keeps its method + photo; only the instants move', async () => {
    if (!ready) return;
    const now = new Date();
    const inAt = new Date(now.getTime() - 2 * 60_000);
    const outAt = new Date(now.getTime() - 60_000);
    const today = keyIn(now);
    if (keyIn(inAt) !== today) return; // the two minutes straddling IST midnight — not worth a flake
    const before = await rawRow(FAKE_USER, today);
    expect(before?.method).toBeTruthy(); // the re-entry suite left a real punch here
    expect(before?.checkInPhotoUrl).toBe('test://face.jpg');

    const r = await attendanceService.applyAdminTimes(ADMIN, { userId: FAKE_USER, date: today, checkInAt: inAt.toISOString(), checkOutAt: outAt.toISOString() });
    expect(r.inTime).toBe(inAt.toISOString());
    expect(r.outTime).toBe(outAt.toISOString());
    expect(r.present).toBe(false);
    expect(r.via).toBe(before.method); // NOT flipped to 'Manual'

    const after = await rawRow(FAKE_USER, today);
    expect(after.checkInPhotoUrl).toBe('test://face.jpg'); // evidence preserved
    expect(after.adjustedBy).toBe(ADMIN);
    expect(after.adjustedAt).toBeInstanceOf(Date);
    const hist = await attendanceService.history(FAKE_USER, 1);
    expect(hist[0]?.adjusted).toBe(true);
  }, 30000);

  it('a day with no punch becomes a Manual row at the given times, left open only for today', async () => {
    if (!ready) return;
    const now = new Date();
    const inAt = new Date(now.getTime() - 60_000);
    const today = keyIn(now);
    if (keyIn(inAt) !== today) return;
    const r = await attendanceService.applyAdminTimes(ADMIN, { userId: FAKE_USER_NEVER, date: today, checkInAt: inAt.toISOString(), checkOutAt: null });
    expect(r.via).toBe('Manual');
    expect(r.inTime).toBe(inAt.toISOString());
    expect(r.outTime).toBeNull();
    expect(r.present).toBe(true); // still in — the 10pm sweep will close it
    const raw = await rawRow(FAKE_USER_NEVER, today);
    expect(raw.checkInPhotoUrl).toBeNull();
    expect(raw.adjustedBy).toBe(ADMIN);
  }, 30000);
});
