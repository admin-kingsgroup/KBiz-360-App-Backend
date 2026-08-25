import { Types } from 'mongoose';
import { BadRequest, Forbidden } from '../../common/errors';
import { crmRepo, type CrmUser, type CrmBranch } from '../crm.repo';
import { accessService, type MongoAccess } from '../access';
import { attendanceRepo } from './attendance.repository';
import { officeRepo } from './office.repository';
import { userOffices } from './userOffices';
import { userWorkBranches } from './userWorkBranches';
import { attendanceExempt } from '../attendanceExempt';
import { attendanceHidden } from '../attendanceHidden';
import { alertService } from '../alerts/alert.service';
import { reportChat } from '../alerts/reportChat.service';
import { attendanceBranchCode, dayKeyIn } from './attendanceBranch';
import { punchChatLine, punchDedupeKey } from './punchMessage';
import { userPositions } from '../userPositions';
import type { OfficeGeofenceDoc } from './office.model';
import type { AttendanceDoc } from './attendance.model';

export interface PunchBody {
  wifiOn?: boolean; // legacy client flag — ignored (never verifiable)
  wifiSsid?: string | null; // the Wi-Fi network the device is actually connected to
  coords?: { lat: number; lng: number } | null;
  method?: 'auto' | 'face';
  // 'geofence' = the headless OS geofence task fired this punch. Only these check-outs get the
  // "still inside the office" drift rejection — user-initiated punches are never second-guessed.
  source?: 'geofence';
  // ISO instant the OS FIRST detected this departure (client-persisted pending-exit marker: the
  // punch itself is often refused/undeliverable at that moment). Geofence-sourced check-outs only;
  // resolveCheckOutAt bounds it before it becomes checkOutAt.
  exitAt?: string;
  // Face photo captured at punch time (uploaded via /api/uploads first). Required for both punches.
  facePhotoUrl?: string | null;
}

const PALETTE = ['#9A6CF0', '#4F8BFF', '#37B6A4', '#E8A13A', '#E3674E', '#0C0E14'];
const colorFor = (id: string): string => PALETTE[[...id].reduce((n, c) => n + c.charCodeAt(0), 0) % PALETTE.length];
const nameOf = (u: CrmUser): string => `${u.first_name ?? ''} ${u.last_name ?? ''}`.trim() || u.email || 'Unknown';
const initialsOf = (name: string): string => name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]).join('').toUpperCase() || '?';

// Punch times are stored in UTC. The attendance DAY and the team view are computed in a FIXED business
// timezone (default IST) so a punch at e.g. 1 AM IST files under the correct local day (not the previous
// UTC day), and times read as the real wall-clock. Override with the ATTENDANCE_TZ env var if HQ moves.
const ATTENDANCE_TZ = process.env.ATTENDANCE_TZ || 'Asia/Kolkata';
// CRM role level 3 — sees the team, but only within their own branch_ids (see `team`).
const BRANCH_MANAGER_LEVEL = 3;
// 'YYYY-MM-DD' for the given instant in the business timezone (en-CA yields that exact format).
const dayKeyInTz = (d: Date): string => {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: ATTENDANCE_TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  } catch {
    return d.toISOString().slice(0, 10);
  }
};
const todayKey = (): string => dayKeyInTz(new Date()); // business-tz calendar day (daily uniqueness)
// Calendar arithmetic on 'YYYY-MM-DD' keys — timezone-free once the key is fixed.
const addDays = (key: string, n: number): string => {
  const d = new Date(`${key}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;
const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
// The UTC instant whose wall clock in the given timezone reads `dayKey hh:mm` (for admin
// corrections entered as business-local times, and branch-local auto-close stamps). Two-step:
// format a UTC guess back into the tz, and shift by the difference.
const atBusinessTime = (dayKey: string, hhmm: string, tz: string = ATTENDANCE_TZ): Date => {
  const guess = new Date(`${dayKey}T${hhmm}:00.000Z`);
  // hourCycle 'h23', NOT hour12:false — the latter selects the h24 cycle in Node's ICU, which
  // renders the midnight hour as "24:30:00" (an unparseable wall clock → Invalid Date). With IST
  // that broke every business time in the 18:30–19:29 window, including the 19:00 defaults.
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  });
  const wall = new Date(fmt.format(guess).replace(', ', 'T').replace(' ', 'T') + 'Z');
  return new Date(guess.getTime() - (wall.getTime() - guess.getTime()));
};
const todayDate = (): Date => new Date(`${todayKey()}T00:00:00.000Z`); // calendar-day marker for the record
function fmtTime(d: Date | null, tz: string = ATTENDANCE_TZ): string | null {
  if (!d) return null;
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit', hour12: true }).format(d);
  } catch {
    return null;
  }
}

// Attendance PUNCH-alert kill-switch (owner call, 07-31; ATTENDANCE_ALERTS=on in production):
// gates the personal "You checked in" alert a puncher gets in My Alerts. It no longer gates the
// day-close report — that is a branch's own daily record and posts to the branch group regardless.
const ATTENDANCE_ALERTS_ENABLED = process.env.ATTENDANCE_ALERTS === 'on';

// Live punch line in the branch's GROUP CHAT (owner call, 2026-08-25) — separate switch from the
// one above: that one gates the puncher's PERSONAL "You checked in" in My Alerts, this one gates
// what a whole room sees. On by default; ATTENDANCE_PUNCH_CHAT=off silences the rooms without a
// redeploy, and the 10pm day-close summary keeps posting either way.
const PUNCH_CHAT_ENABLED = process.env.ATTENDANCE_PUNCH_CHAT !== 'off';

// Forgotten check-outs (owner call, 07-31): the 10pm sweep closes any day still open, stamping the
// check-out at 7pm — NOT the sweep hour — labelled method 'Auto-closed' so it is visibly different
// from a real punch. A check-in AFTER the stamp hour closes at the check-in instant instead
// (a checkout can never precede its check-in).
const AUTO_CLOSE_STAMP = process.env.ATTENDANCE_AUTOCLOSE_TIME || '19:00';

// The stamp is BRANCH-LOCAL (owner call, 08-07): stamping 19:00 IST was writing 16:30 local
// checkouts in NBO/DAR and 15:30 local in FBM. African branches close at their OFFICE END time,
// not 7pm (owner call, 08-07). CRM branch docs carry only code/city, so both the IANA zone and
// the stamp are resolved from the branch code here; unknown codes (BOM/AMD/BOMMB/…) fall back to
// the business timezone (IST) at the 7pm default.
const BRANCH_AUTO_CLOSE: Record<string, { tz: string; stamp: string }> = {
  NBO: { tz: 'Africa/Nairobi', stamp: '18:30' },       // Kenya, UTC+3 — office 8:30–6:30
  DAR: { tz: 'Africa/Dar_es_Salaam', stamp: '17:30' }, // Tanzania, UTC+3 — office 8:30–5:30
  FBM: { tz: 'Africa/Lubumbashi', stamp: '17:30' },    // DR Congo south-east, UTC+2 — office 8:30–5:30
};
export const branchAutoClose = (branch: { code?: string | null } | null | undefined): { tz: string; stamp: string } =>
  BRANCH_AUTO_CLOSE[String(branch?.code ?? '').trim().toUpperCase()] ?? { tz: ATTENDANCE_TZ, stamp: AUTO_CLOSE_STAMP };

// Pure: the instant a forgotten day is closed at (exported for tests).
export function resolveAutoCloseAt(dayKey: string, checkInAt: Date, stampHHmm: string = AUTO_CLOSE_STAMP, tz: string = ATTENDANCE_TZ): Date {
  const stamp = atBusinessTime(dayKey, stampHHmm, tz);
  return checkInAt.getTime() > stamp.getTime() ? checkInAt : stamp;
}

// The auto-close ACTION fires at 10pm in the BRANCH's local night (owner call, 08-07), not 10pm
// IST — FBM's 10pm is 01:30 IST the next calendar day. Pure predicate: has `day` reached the
// close hour in `tz` as of instant `at`? (Exported for tests.)
const DAY_CLOSE_HOUR = Math.min(23, Math.max(0, Number(process.env.ATTENDANCE_DAYCLOSE_HOUR ?? 22)));
const DAY_CLOSE_HHMM = `${String(DAY_CLOSE_HOUR).padStart(2, '0')}:00`;
export function autoCloseDue(dayKey: string, tz: string, at: Date): boolean {
  return at.getTime() >= atBusinessTime(dayKey, DAY_CLOSE_HHMM, tz).getTime();
}

// Exit hysteresis is ZERO (owner call, 07-28): check-out is immediate the moment a fix is beyond
// the office radius — no extra buffer. The false-exit protection that remains is evidence-quality
// only (a fix is required; no-fix + still on office Wi-Fi is drift), which adds no delay.
export const GEOFENCE_EXIT_BUFFER_M = 0;

// Pure decision for the geofence-exit drift guard: is this punch still provably at the office?
// STRICT presence = inside the fence AND on the office Wi-Fi (when the office has an SSID), so a
// geofence-fired exit is rejected as drift ONLY while both legs still hold:
//   - no fix + still on office Wi-Fi → drift (Wi-Fi anchors them on-site; GPS silence isn't leaving)
//   - fix inside radius+buffer AND (office has no SSID OR still on office Wi-Fi) → drift
//   - anything else → the exit stands (either leg provably broke).
export function geofenceExitStillInside(
  offices: { lat: number; lng: number; radius: number; wifiSsid?: string | null }[],
  coords: { lat: number; lng: number } | null | undefined,
  wifiVerified: boolean,
): boolean {
  if (!offices.length) return false;
  if (!coords) return wifiVerified;
  let best: { d: number; r: number; ssid: string | null } | null = null;
  for (const o of offices) {
    const d = haversine(coords, { lat: o.lat, lng: o.lng });
    if (!best || d < best.d) best = { d, r: o.radius, ssid: normalizeSsid(o.wifiSsid) };
  }
  if (!best || best.d > best.r + GEOFENCE_EXIT_BUFFER_M) return false; // clearly beyond the fence
  return best.ssid ? wifiVerified : true; // inside the fence: Wi-Fi leg must hold too when required
}

// Pure decision: which instant a check-out is stamped with. The punch often lands LONG after the
// person actually left — the Exit event fired with no usable fix, then Doze deferred the phone's
// reconcile for 1–2 hours — and stamping arrival time recorded all of that delay as a late
// checkout. A geofence-sourced punch may therefore carry `exitAt`, the client-persisted instant
// the OS FIRST detected the departure, and the check-out is back-dated to it. Hard bounds (bad
// clock / spoof guard) — outside any of them the claim is distrusted and arrival time stands:
//   - must parse, and not lie in the future;
//   - must fall strictly AFTER today's check-in (a marker predating it is stale drift);
//   - must be the same business day as the punch (yesterday's marker can't close today).
export function resolveCheckOutAt(
  body: Pick<PunchBody, 'source' | 'exitAt'>,
  checkInAt: Date | null | undefined,
  now: Date,
): Date {
  if (body.source !== 'geofence' || !body.exitAt) return now;
  const claimed = new Date(body.exitAt);
  const t = claimed.getTime();
  if (!Number.isFinite(t) || t > now.getTime()) return now;
  if (!checkInAt || t <= checkInAt.getTime()) return now;
  if (dayKeyInTz(claimed) !== dayKeyInTz(now)) return now;
  return claimed;
}

// Pure decision for who the team view covers (GET /attendance/team).
//   seesTeam  — false = the viewer only ever sees their own record.
//   branchIds — null = every branch in the tenant; otherwise narrow to these WORKING branches.
// Company-wide roles (super_admin, company_manager) get the tenant; a branch manager gets exactly
// their assigned branches; hod/employee — and a branch manager with no branches — get themselves.
export function teamScope(
  viewer: Pick<MongoAccess, 'canManage' | 'companyWide' | 'level' | 'branchIds'>,
): { seesTeam: boolean; branchIds: string[] | null } {
  if (viewer.canManage) return { seesTeam: true, branchIds: viewer.companyWide ? null : (viewer.branchIds ?? []) };
  const own = viewer.branchIds ?? [];
  if (viewer.level <= BRANCH_MANAGER_LEVEL && own.length > 0) return { seesTeam: true, branchIds: own };
  return { seesTeam: false, branchIds: null };
}

// ── who is tracked at all ──
// Super-admins are NEVER tracked (the developer/owner accounts shouldn't produce punches or
// pollute the team view), on top of the explicit per-user attendance_exempt list.
// Pure so it's testable: mirrors deriveAccess's isSuper rule (level 1 or the '*' permission).
export function superUserIds(
  users: Pick<CrmUser, '_id' | 'role_id'>[],
  roles: { _id: unknown; level?: number; permissions?: string[] }[],
): Set<string> {
  const superRoles = new Set(
    roles.filter((r) => (r.level ?? 5) === 1 || (r.permissions ?? []).includes('*')).map((r) => String(r._id)),
  );
  return new Set(users.filter((u) => u.role_id && superRoles.has(String(u.role_id))).map((u) => String(u._id)));
}

// Single-user form, for the punch/me paths.
// HIDDEN (director) users are ALWAYS tracked — even when their role is super-admin or they sit on
// the exempt list — their attendance just records silently (see attendanceHidden).
async function isUntracked(userId: string): Promise<boolean> {
  if (await attendanceHidden.isHidden(userId)) return false;
  if (await attendanceExempt.isExempt(userId)) return true;
  const access = await accessService.accessForUserId(userId);
  return !!access?.isSuper;
}

function viaFor(body: PunchBody, wifiVerified: boolean): string {
  if (body.method === 'face') return 'Face';
  if (wifiVerified) return 'Wi-Fi';
  if (body.coords) return 'Geofence';
  return 'Auto';
}

// ── Wi-Fi lock ──
// Android reports the SSID wrapped in quotes ("Office 5G") and '<unknown ssid>' when it can't read it.
const cleanSsid = (s?: string | null): string | null => {
  if (!s) return null;
  const t = s.trim().replace(/^"(.*)"$/, '$1').trim();
  return t && t.toLowerCase() !== '<unknown ssid>' ? t : null;
};
const normalizeSsid = (s?: string | null): string | null => cleanSsid(s)?.toLowerCase() ?? null;
// True when the device's reported Wi-Fi network matches an office's configured SSID.
function wifiVerifiedFor(offices: OfficeGeofenceDoc[], reportedSsid?: string | null): boolean {
  const reported = normalizeSsid(reportedSsid);
  return !!reported && offices.some((o) => normalizeSsid(o.wifiSsid) === reported);
}

// ── geofence (anti-spoofing) ──
type Coords = { lat: number; lng: number };
function haversine(a: Coords, b: Coords): number {
  const R = 6371000;
  const toRad = (x: number): number => (x * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(s)));
}
// Nearest configured office to the given coords (+ whether it's inside that office's radius).
function nearestOffice(offices: OfficeGeofenceDoc[], coords: Coords): { office: OfficeGeofenceDoc; distance: number; within: boolean } | null {
  let best: { office: OfficeGeofenceDoc; distance: number } | null = null;
  for (const o of offices) {
    const distance = haversine(coords, { lat: o.lat, lng: o.lng });
    if (!best || distance < best.distance) best = { office: o, distance };
  }
  return best ? { ...best, within: best.distance <= best.office.radius } : null;
}
// Default office(s) per branch: the branch's DEFAULT office if one is set, else ALL its offices.
function preferDefaults(offices: OfficeGeofenceDoc[]): OfficeGeofenceDoc[] {
  const defaults = offices.filter((o) => o.isDefault);
  return defaults.length ? defaults : offices;
}

// The offices a user may punch at, in priority order:
//   1. An explicit per-user OFFICE assignment (e.g. Faiz → Bombay HQ) — locks them to exactly that office.
//   2. An explicit WORKING BRANCH assignment — restricts them to that branch's default office(s).
//   3. Otherwise, for each of their branches: the branch's DEFAULT office if one is set, else ALL the
//      branch's offices (so single-office branches and un-defaulted branches keep working unchanged).
// Company-wide roles with no assignment see every tenant office.
async function officesForUser(userId: string): Promise<OfficeGeofenceDoc[]> {
  const access = await accessService.accessForUserId(userId);
  if (!access) return [];

  const assignedId = await userOffices.officeIdFor(userId);
  if (assignedId) {
    const o = await officeRepo.byId(assignedId);
    if (o && o.active) return [o];
    // assigned office was deleted/deactivated — fall through to branch defaults
  }

  // HIDDEN (director) attendance geofences against ANY office company-wide (owner call, 07-31) —
  // a working-branch assignment only pins where they DISPLAY in the team view, never where their
  // background attendance can record. (An explicit office assignment above still narrows it.)
  if (await attendanceHidden.isHidden(userId)) return officeRepo.listByTenant(access.tenantId);

  const workBranchId = await userWorkBranches.branchIdFor(userId);
  if (workBranchId) return preferDefaults(await officeRepo.byBranchIds([workBranchId]));

  if (access.companyWide) return officeRepo.listByTenant(access.tenantId);
  const branchIds = access.branchIds ?? [];
  if (!branchIds.length) return [];

  const all = await officeRepo.byBranchIds(branchIds);
  // Per branch: prefer the default office; otherwise include all of that branch's offices.
  const out: OfficeGeofenceDoc[] = [];
  for (const bId of new Set(all.map((o) => o.branchId))) {
    out.push(...preferDefaults(all.filter((o) => o.branchId === bId)));
  }
  return out;
}

function mapMe(doc: AttendanceDoc | null) {
  if (!doc) return { date: todayKey(), inTime: null, outTime: null, via: null, present: false };
  return {
    date: doc.dateKey,
    inTime: doc.checkInAt ? doc.checkInAt.toISOString() : null,
    outTime: doc.checkOutAt ? doc.checkOutAt.toISOString() : null,
    via: doc.method,
    present: doc.present,
    latitude: doc.latitude,
    longitude: doc.longitude,
    distanceMeters: doc.distanceMeters,
    wifiSsid: doc.wifiSsid,
    faceVerified: doc.faceVerified,
    checkInPhotoUrl: doc.checkInPhotoUrl ?? null,
    checkOutPhotoUrl: doc.checkOutPhotoUrl ?? null,
  };
}

// One attempt per (branch, day) per process. The sweep ticks every minute across a six-hour
// window so that every branch's own 10pm falls inside it; without this, each tick after a branch
// has reported would re-read the whole directory and its attendance to discover that the chat
// post is a duplicate. A failed attempt is remembered too — a branch whose group has been renamed
// must not log the same warning 360 times a night.
const reportedTonight = new Set<string>();

// A punch also shows up LIVE in the puncher's branch group — "🟢 Priya Patel checked in · 9:42 AM
// · Geofence" — in the SAME room the 10pm day-close summary posts to ("HQ - <CODE> Finance", the
// hub's "MHUB - Finance Team"). Reusing that group is what makes this work on day one: every
// branch already has one, and nobody has to create or populate a new room.
//
// Which branch: the explicit working-branch assignment, else the user's first CRM branch — the
// same rule the day-close report and the team view resolve with, so a person's live line and
// their line in that night's summary can never land in different rooms.
//
// Times are the BRANCH's wall clock, not IST: Nairobi reads Nairobi.
//
// Never throws and never blocks the punch — callers fire it with `void`. A branch that resolves
// to no code, a group renamed past recognition, chat storage down: all of it is a log warning.
// Recording attendance must not depend on being able to announce it.
//
// Hidden (director) users never reach here — their attendance is private by design, the same
// reason they are absent from the day-close summary.
async function postPunchToBranchGroup(userId: string, action: 'in' | 'out', at: Date, via: string | null): Promise<void> {
  try {
    const user = await crmRepo.getUserById(userId);
    if (!user) return;
    const assigned = await userWorkBranches.branchIdFor(userId);
    const branchId = assigned ?? String((user.branch_ids ?? [])[0] ?? '');
    if (!Types.ObjectId.isValid(branchId)) return; // no branch at all → no room this belongs in
    const [branch] = await crmRepo.branchesByIds([new Types.ObjectId(branchId)]);
    const branchCode = attendanceBranchCode(branch ?? null);
    if (!branchCode) return; // unresolvable code (BOMMB/MUM and cities are handled inside)
    const { tz } = branchAutoClose({ code: branchCode });
    await reportChat.post({
      branchCode,
      group: 'finance',
      title: punchChatLine({ name: nameOf(user), action, time: fmtTime(at, tz), via }),
      dedupeKey: punchDedupeKey(branchCode, dayKeyIn(tz, at), userId, action),
    });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(`[attendance-punch-chat] ${userId} ${action}: ${(e as Error).message}`);
  }
}

export const attendanceService = {
  // Punch gate (owner rules, 07-31): BOTH check-in and check-out require
  //   1. a live GPS fix INSIDE one of the user's office geofences (radius, default 100 m), and
  //   2. a face photo captured at punch time (enforced by the callers, not here).
  // No Wi-Fi requirement any more — Wi-Fi match is recorded as info only. If no office is
  // configured at all, the punch is allowed unverified (attendance isn't bricked before setup).
  async assertAtOffice(userId: string, body: PunchBody): Promise<{ distance: number | null; wifiVerified: boolean }> {
    const offices = await officesForUser(userId);
    if (!offices.length) return { distance: null, wifiVerified: false }; // nothing to validate against yet
    if (!body.coords) throw Forbidden('Location is required to record attendance — enable location and try again');
    const near = nearestOffice(offices, body.coords);
    if (!near || !near.within) {
      throw Forbidden(near ? `You must be within ${near.office.radius} m of your office — you are ${near.distance} m away` : 'You are not at a registered office');
    }
    const wifiVerified = wifiVerifiedFor(offices, body.wifiSsid);
    return { distance: near.distance, wifiVerified };
  },

  // POST /attendance/check-in — first punch of the day, OR a re-entry after a check-out.
  // Re-entry model: first-in stays, last-out wins. A check-in on an already-closed day (e.g. the
  // geofence drifted you out at lunch, or you left and came back) RE-OPENS it — checkOutAt clears,
  // presence resumes, the original checkInAt is preserved. This makes the day self-healing: any
  // spurious check-out is undone the moment presence at the office is proven again.
  async checkIn(userId: string, body: PunchBody) {
    if (await isUntracked(userId)) throw BadRequest('Attendance is not tracked for your account');
    // Hidden (director) punches are fully automatic — no face photo exists for them by design.
    const hidden = await attendanceHidden.isHidden(userId);
    if (!hidden && !body.facePhotoUrl) throw BadRequest('A face photo is required to check in');
    const key = todayKey();
    const today = await attendanceRepo.findToday(userId, key);
    if (today?.checkInAt && !today.checkOutAt) throw BadRequest('Already checked in today');
    const reopening = !!(today?.checkInAt && today.checkOutAt);
    const { distance, wifiVerified } = await this.assertAtOffice(userId, body);
    const now = new Date();
    const saved = await attendanceRepo.upsert(userId, key, {
      ...(reopening ? {} : { date: todayDate(), checkInAt: now }),
      checkOutAt: null,
      method: viaFor(body, wifiVerified),
      present: true,
      latitude: body.coords?.lat ?? null,
      longitude: body.coords?.lng ?? null,
      distanceMeters: distance,
      wifiSsid: wifiVerified ? cleanSsid(body.wifiSsid) : null,
      faceVerified: hidden ? null : true, // a face photo is mandatory on every manual punch
      checkInPhotoUrl: body.facePhotoUrl ?? null,
    });
    // Two fire-and-forget announcements: the puncher's own "You checked in" in My Alerts, and the
    // live line in their branch's group chat. NEVER for hidden users — their punches surface nowhere.
    if (ATTENDANCE_ALERTS_ENABLED && !hidden) void alertService.recordAttendancePunch(userId, 'in', now, saved?.method ?? null);
    if (PUNCH_CHAT_ENABLED && !hidden) void postPunchToBranchGroup(userId, 'in', now, saved?.method ?? null);
    return mapMe(saved);
  },

  // POST /attendance/check-out — closes the day. Same gate as check-in (owner rules, 07-31):
  // must be within the office geofence with a face photo captured at punch time.
  async checkOut(userId: string, body: PunchBody) {
    if (await isUntracked(userId)) throw BadRequest('Attendance is not tracked for your account');
    const hidden = await attendanceHidden.isHidden(userId);
    if (!hidden && !body.facePhotoUrl) throw BadRequest('A face photo is required to check out');
    const key = todayKey();
    const today = await attendanceRepo.findToday(userId, key);
    if (!today?.checkInAt) throw BadRequest('Not checked in');
    if (today.checkOutAt) throw BadRequest('Already checked out');
    const now = new Date();
    // Hidden check-outs may arrive from OUTSIDE the fence (that's what a departure is) — the
    // geofence gate applies to manual punches only; the coords are still recorded.
    const { distance, wifiVerified } = hidden
      ? await (async () => {
          const offices = await officesForUser(userId);
          return {
            distance: body.coords && offices.length ? (nearestOffice(offices, body.coords)?.distance ?? null) : null,
            wifiVerified: wifiVerifiedFor(offices, body.wifiSsid),
          };
        })()
      : await this.assertAtOffice(userId, body);
    const outAt = resolveCheckOutAt(body, today.checkInAt, now);
    const saved = await attendanceRepo.upsert(userId, key, {
      checkOutAt: outAt,
      method: viaFor(body, wifiVerified),
      present: false,
      distanceMeters: distance ?? today.distanceMeters,
      faceVerified: hidden ? today.faceVerified : true,
      checkOutPhotoUrl: body.facePhotoUrl ?? null,
    });
    // Same pair as check-in: the puncher's own My Alerts event, and the branch group's live line.
    if (ATTENDANCE_ALERTS_ENABLED && !hidden) void alertService.recordAttendancePunch(userId, 'out', outAt, saved?.method ?? null);
    if (PUNCH_CHAT_ENABLED && !hidden) void postPunchToBranchGroup(userId, 'out', outAt, saved?.method ?? null);
    return mapMe(saved);
  },

  // GET /attendance/offices — the geofences the caller may punch at (drives the app's office picker
  // + geofence presence). Labels resolved from the CRM branch when not overridden.
  async offices(userId: string) {
    const offices = await officesForUser(userId);
    const ids = offices.map((o) => o.branchId).filter((id) => Types.ObjectId.isValid(id)).map((id) => new Types.ObjectId(id));
    const branches = ids.length ? await crmRepo.branchesByIds(ids) : [];
    const labelById = new Map(branches.map((b) => [String(b._id), b.code || b.name || 'Office']));
    return offices.map((o) => ({
      id: String(o._id),
      branchId: o.branchId,
      label: o.label || labelById.get(o.branchId) || 'Office',
      address: o.address ?? null,
      lat: o.lat,
      lng: o.lng,
      radius: o.radius,
      wifiSsid: o.wifiSsid,
    }));
  },

  // GET /attendance/offices/admin — every tenant branch with its list of offices (0, 1, or many),
  // so an admin can add/edit offices per branch. Manager-only (enforced by the route).
  async adminListOffices(userId: string) {
    const access = await accessService.accessForUserId(userId);
    if (!access) throw Forbidden('Session user not found');
    const filter: Record<string, unknown> = {};
    if (access.tenantId && Types.ObjectId.isValid(access.tenantId)) filter.tenant_id = new Types.ObjectId(access.tenantId);
    const branches = await crmRepo.listBranches(filter);
    const configs = await officeRepo.listByTenant(access.tenantId);
    const byBranch = new Map<string, typeof configs>();
    for (const c of configs) { const arr = byBranch.get(c.branchId) ?? []; arr.push(c); byBranch.set(c.branchId, arr); }
    return branches.map((b) => {
      const id = String(b._id);
      const offices = (byBranch.get(id) ?? []).map((c) => ({
        id: String(c._id),
        label: c.label ?? null,
        address: c.address ?? null,
        lat: c.lat,
        lng: c.lng,
        radius: c.radius,
        active: c.active,
        isDefault: c.isDefault ?? false,
        wifiSsid: c.wifiSsid ?? null,
        updatedAt: c.updatedAt ? c.updatedAt.toISOString() : null,
      }));
      return {
        branchId: id,
        code: b.code ?? null,
        name: b.name ?? null,
        city: b.city ?? null,
        offices, // may be empty
      };
    });
  },

  // POST /attendance/offices — add an office to a branch. Manager-only.
  async createOffice(userId: string, body: { branchId: string; lat: number; lng: number; radius?: number; label?: string | null; address?: string | null; wifiSsid?: string | null; isDefault?: boolean }) {
    const access = await accessService.accessForUserId(userId);
    if (!access) throw Forbidden('Session user not found');
    const created = await officeRepo.create({
      branchId: body.branchId,
      tenantId: access.tenantId,
      lat: body.lat,
      lng: body.lng,
      radius: body.radius ?? 100,
      label: body.label ?? null,
      address: body.address ?? null,
      wifiSsid: body.wifiSsid ?? null,
      active: true,
      isDefault: false,
      updatedBy: userId,
    });
    // First office in a branch becomes its default automatically; or honour an explicit request.
    const siblings = await officeRepo.allByBranchIds([body.branchId]);
    if (body.isDefault || siblings.length === 1) await officeRepo.setDefault(body.branchId, String(created._id));
    return officeRepo.byId(String(created._id));
  },

  // PUT /attendance/offices/id/:officeId — edit an office. Manager-only.
  async updateOffice(userId: string, officeId: string, body: { lat?: number; lng?: number; radius?: number; label?: string | null; address?: string | null; wifiSsid?: string | null; active?: boolean; isDefault?: boolean }) {
    const access = await accessService.accessForUserId(userId);
    if (!access) throw Forbidden('Session user not found');
    const existing = await officeRepo.byId(officeId);
    if (!existing) throw BadRequest('Office not found');
    const set: Record<string, unknown> = { updatedBy: userId };
    for (const k of ['lat', 'lng', 'radius', 'label', 'address', 'wifiSsid', 'active'] as const) {
      if (body[k] !== undefined) set[k] = body[k];
    }
    await officeRepo.updateById(officeId, set);
    if (body.isDefault) await officeRepo.setDefault(existing.branchId, officeId);
    return officeRepo.byId(officeId);
  },

  // DELETE /attendance/offices/id/:officeId. Manager-only. (Users assigned to it fall back to default.)
  async deleteOffice(userId: string, officeId: string) {
    const access = await accessService.accessForUserId(userId);
    if (!access) throw Forbidden('Session user not found');
    await officeRepo.deleteById(officeId);
    return { ok: true };
  },

  // POST /attendance/offices/id/:officeId/default — make this the branch default. Manager-only.
  async setDefaultOffice(userId: string, officeId: string) {
    const access = await accessService.accessForUserId(userId);
    if (!access) throw Forbidden('Session user not found');
    const o = await officeRepo.byId(officeId);
    if (!o) throw BadRequest('Office not found');
    await officeRepo.setDefault(o.branchId, officeId);
    return officeRepo.byId(officeId);
  },

  // GET /attendance/offices/assignments → { [userId]: officeId } for the manager's tenant users.
  async listAssignments(userId: string) {
    const access = await accessService.accessForUserId(userId);
    if (!access) throw Forbidden('Session user not found');
    const filter: Record<string, unknown> = { status: 'active' };
    if (access.tenantId && Types.ObjectId.isValid(access.tenantId)) filter.tenant_id = new Types.ObjectId(access.tenantId);
    const users = await crmRepo.listUsers(filter);
    return userOffices.mapFor(users.map((u) => String(u._id)));
  },

  // POST /attendance/offices/assign { userId, officeId } → lock a user to an office (null clears). Manager-only.
  async assignUserOffice(adminId: string, targetUserId: string, officeId: string | null) {
    const access = await accessService.accessForUserId(adminId);
    if (!access) throw Forbidden('Session user not found');
    if (officeId) {
      const o = await officeRepo.byId(officeId);
      if (!o) throw BadRequest('Office not found');
    }
    await userOffices.setOffice(targetUserId, officeId, adminId);
    return { ok: true };
  },

  // GET /attendance/work-branches → { [userId]: branchId } explicit working-branch assignments.
  async listWorkBranchAssignments(userId: string) {
    const access = await accessService.accessForUserId(userId);
    if (!access) throw Forbidden('Session user not found');
    const filter: Record<string, unknown> = { status: 'active' };
    if (access.tenantId && Types.ObjectId.isValid(access.tenantId)) filter.tenant_id = new Types.ObjectId(access.tenantId);
    const users = await crmRepo.listUsers(filter);
    return userWorkBranches.mapFor(users.map((u) => String(u._id)));
  },

  // POST /attendance/work-branches/assign { userId, branchId } → set where a user marks attendance
  // (null clears → falls back to their first CRM access branch). Manager-only.
  async assignUserWorkBranch(adminId: string, targetUserId: string, branchId: string | null) {
    const access = await accessService.accessForUserId(adminId);
    if (!access) throw Forbidden('Session user not found');
    if (branchId) {
      if (!Types.ObjectId.isValid(branchId)) throw BadRequest('Invalid branch');
      const [branch] = await crmRepo.branchesByIds([new Types.ObjectId(branchId)]);
      if (!branch) throw BadRequest('Branch not found');
      // An explicit office assignment in a DIFFERENT branch would contradict the new working branch
      // (office assignments take priority when validating punches) — clear it so the branch wins.
      const assignedOfficeId = await userOffices.officeIdFor(targetUserId);
      if (assignedOfficeId) {
        const office = await officeRepo.byId(assignedOfficeId);
        if (office && office.branchId !== branchId) await userOffices.setOffice(targetUserId, null, adminId);
      }
    }
    await userWorkBranches.setBranch(targetUserId, branchId, adminId);
    return { ok: true };
  },

  // GET /attendance/history — the caller's recent attendance, one entry per calendar day
  // (newest first). Days with no punch row come back as ABSENT entries so past absences are
  // visible; the walk never goes past the user's first-ever record (no fake absences before
  // they started punching).
  async history(userId: string, days = 30, fillFullWindow = false) {
    const limit = Math.min(Math.max(days, 1), 180);
    const rows = await attendanceRepo.historyForUser(userId, limit);
    const first = await attendanceRepo.firstForUser(userId);
    if (!first && !fillFullWindow) return [];
    const floor = fillFullWindow ? addDays(todayKey(), -(limit - 1)) : (first as NonNullable<typeof first>).dateKey;
    const byKey = new Map(rows.map((r) => [r.dateKey, r]));
    const out = [];
    for (let key = todayKey(); out.length < limit && key >= floor; key = addDays(key, -1)) {
      const r = byKey.get(key);
      out.push({
        date: key,
        inTime: r?.checkInAt ? r.checkInAt.toISOString() : null,
        outTime: r?.checkOutAt ? r.checkOutAt.toISOString() : null,
        via: r?.method ?? null,
        present: !!r?.checkInAt, // was present that day (doc.present means "currently in office")
        distanceMeters: r?.distanceMeters ?? null,
        inPhoto: r?.checkInPhotoUrl ?? null, // face photos — shown in the admin team view
        outPhoto: r?.checkOutPhotoUrl ?? null,
      });
    }
    return out;
  },

  // GET /attendance/history/user/:userId — a teammate's attendance history, for the admin
  // team view. Manager-only (route), and the target must belong to the viewer's tenant.
  async historyForUserAsAdmin(adminId: string, targetUserId: string, days = 30) {
    const viewer = await accessService.accessForUserId(adminId);
    if (!viewer?.canManage) throw Forbidden('Requires super_admin or company_manager');
    const target = await crmRepo.getUserById(targetUserId);
    if (!target) throw BadRequest('User not found');
    if (viewer.tenantId && target.tenant_id && String(target.tenant_id) !== viewer.tenantId) {
      throw Forbidden('User is outside your tenant');
    }
    // Full window (not clamped to the first record) so the admin can also correct days the
    // app never recorded at all — e.g. a rejected auto punch on a user's very first day.
    return this.history(targetUserId, days, true);
  },

  // POST /attendance/admin/day — admin correction: mark a user PRESENT (with business-local
  // times, default 10:00–19:00) or ABSENT for one calendar day. Stored as method 'Manual' with
  // adjustedBy/adjustedAt so corrected days are distinguishable from real punches. Manager-only
  // (route), target must belong to the viewer's tenant.
  async adminSetDay(adminId: string, body: { userId: string; date: string; present: boolean; inTime?: string; outTime?: string }) {
    const viewer = await accessService.accessForUserId(adminId);
    if (!viewer?.canManage) throw Forbidden('Requires super_admin or company_manager');
    if (!DAY_KEY_RE.test(body.date) || body.date > todayKey()) throw BadRequest('Invalid date — expected YYYY-MM-DD, not in the future');
    if ((body.inTime && !HHMM_RE.test(body.inTime)) || (body.outTime && !HHMM_RE.test(body.outTime))) throw BadRequest('Times must be HH:mm');
    const target = await crmRepo.getUserById(body.userId);
    if (!target) throw BadRequest('User not found');
    if (viewer.tenantId && target.tenant_id && String(target.tenant_id) !== viewer.tenantId) throw Forbidden('User is outside your tenant');

    const audit = { adjustedBy: adminId, adjustedAt: new Date() };
    let set;
    if (body.present) {
      // Marking TODAY present leaves the day open (no checkout yet) unless a time was given.
      const checkOutAt = body.outTime
        ? atBusinessTime(body.date, body.outTime)
        : body.date === todayKey() ? null : atBusinessTime(body.date, '19:00');
      set = {
        date: new Date(`${body.date}T00:00:00.000Z`),
        checkInAt: atBusinessTime(body.date, body.inTime ?? '10:00'),
        checkOutAt,
        method: 'Manual',
        present: !checkOutAt,
        latitude: null, longitude: null, distanceMeters: null, wifiSsid: null, faceVerified: null,
        checkInPhotoUrl: null, checkOutPhotoUrl: null,
        ...audit,
      };
    } else {
      set = {
        date: new Date(`${body.date}T00:00:00.000Z`),
        checkInAt: null, checkOutAt: null, method: 'Manual', present: false,
        latitude: null, longitude: null, distanceMeters: null, wifiSsid: null, faceVerified: null,
        checkInPhotoUrl: null, checkOutPhotoUrl: null,
        ...audit,
      };
    }
    return mapMe(await attendanceRepo.upsert(body.userId, body.date, set));
  },

  // GET /attendance/me — today's status. `hidden` = background attendance (directors): the app
  // shows no punch UI and runs the silent geofence engine instead.
  async me(userId: string) {
    const base = mapMe(await attendanceRepo.findToday(userId, todayKey()));
    return { ...base, exempt: await isUntracked(userId), hidden: await attendanceHidden.isHidden(userId) };
  },

  // GET /attendance/team — attendance for the people the viewer oversees, for one calendar
  // day (?date=YYYY-MM-DD, business-tz; defaults to today — lets the admin browse past days).
  // Company-wide managers (super_admin / company_manager) see their whole tenant; branch managers
  // see only the people whose WORKING branch is one of theirs; everyone else sees just themselves.
  async team(userId: string, dateKey?: string) {
    if (dateKey !== undefined && (!DAY_KEY_RE.test(dateKey) || dateKey > todayKey())) {
      throw BadRequest('Invalid date — expected YYYY-MM-DD, not in the future');
    }
    const day = dateKey ?? todayKey();
    const viewer = await accessService.accessForUserId(userId);
    if (!viewer) throw Forbidden('Session user not found');

    const { seesTeam, branchIds: visibleBranchIds } = teamScope(viewer);
    let users: CrmUser[];
    if (seesTeam) {
      const filter: Record<string, unknown> = { status: 'active' };
      if (viewer.tenantId && Types.ObjectId.isValid(viewer.tenantId)) filter.tenant_id = new Types.ObjectId(viewer.tenantId);
      users = await crmRepo.listUsers(filter);
    } else {
      const self = await crmRepo.getUserById(userId);
      users = self ? [self] : [];
    }

    // Drop untracked people from the team list: explicit exemptions + every super-admin.
    // HIDDEN (director) attendance is visible ONLY to super-admin viewers — everyone else's team
    // list behaves as if the directors were not tracked at all.
    const exempt = await attendanceExempt.exemptSet();
    const supers = superUserIds(users, await crmRepo.listRoles());
    const hiddenSet = await attendanceHidden.hiddenSet();
    users = users.filter((u) => {
      const id = String(u._id);
      if (hiddenSet.has(id)) return !!viewer.isSuper;
      return !exempt.has(id) && !supers.has(id);
    });

    // Each user's WORKING branch: explicit assignment → first CRM access branch. Resolved BEFORE
    // the attendance read so a branch manager's narrowing happens before we fetch punch records.
    const workBranches = await userWorkBranches.mapFor(users.map((u) => String(u._id)));
    const workBranchOf = (u: CrmUser): string => {
      const id = String(u._id);
      return workBranches[id] ?? ((u.branch_ids ?? [])[0] ? String((u.branch_ids ?? [])[0]) : '');
    };
    if (visibleBranchIds) {
      const mine = new Set(visibleBranchIds);
      users = users.filter((u) => mine.has(workBranchOf(u)) || String(u._id) === userId);
    }

    const ids = users.map((u) => String(u._id));
    const records = await attendanceRepo.forUsersOnDay(day, ids);
    const byUser = new Map(records.map((r) => [r.userId, r]));

    // Resolve branch labels for the displayed users.
    const branchIds = [...new Set(users.map(workBranchOf).filter(Boolean))]
      .filter((id) => Types.ObjectId.isValid(id)).map((id) => new Types.ObjectId(id));
    const branches: CrmBranch[] = branchIds.length ? await crmRepo.branchesByIds(branchIds) : [];
    const branchById = new Map(branches.map((b) => [String(b._id), b.code || b.name || '—']));

    // Resolve each user's office: explicit assignment → branch default. Lets the super-admin see
    // who reports where and reassign from the attendance screen.
    const assignments = await userOffices.mapFor(ids);
    const positions = await userPositions.mapFor(ids);
    const allOffices = await officeRepo.listByTenant(viewer.tenantId);
    const officeById = new Map(allOffices.map((o) => [String(o._id), o]));
    const defaultByBranch = new Map<string, (typeof allOffices)[number]>();
    for (const o of allOffices) if (o.isDefault) defaultByBranch.set(o.branchId, o);
    const officeLabel = (o: (typeof allOffices)[number] | undefined): string | null =>
      o ? (o.label || branchById.get(o.branchId) || 'Office') : null;

    return users
      .map((u) => {
        const id = String(u._id);
        const rec = byUser.get(id);
        const name = nameOf(u);
        const branchId = workBranchOf(u);
        const assignedId = assignments[id] ?? null;
        const resolved = (assignedId ? officeById.get(assignedId) : undefined) ?? defaultByBranch.get(branchId);
        return {
          id,
          name,
          initials: initialsOf(name),
          color: colorFor(id),
          branch: branchById.get(branchId) ?? '—',
          branchId,
          workBranchId: workBranches[id] ?? null,
          position: positions[id] ?? null,
          office: officeLabel(resolved),
          officeId: assignedId,
          in: fmtTime(rec?.checkInAt ?? null),
          out: fmtTime(rec?.checkOutAt ?? null),
          via: rec?.method ?? undefined,
          inPhoto: rec?.checkInPhotoUrl ?? null, // face photos captured at punch time (admin view)
          outPhoto: rec?.checkOutPhotoUrl ?? null,
        };
      })
      .sort((a, b) => (b.in ? 1 : 0) - (a.in ? 1 : 0) || a.name.localeCompare(b.name)); // present first
  },

  // AUTO-CLOSE forgotten check-outs (owner call, 07-31). Runs from the 10pm sweep — check-out now
  // requires being AT the office, so someone who left without punching can never close their day
  // themselves. Every day still open gets checkOutAt stamped at 7pm business time (or the check-in
  // instant if they punched in later than that), method 'Auto-closed'. Idempotent: once closed, a
  // row no longer matches the open-day query. Runs regardless of the alerts kill-switch.
  // NOTE: this runs BEFORE dayCloseReport in the sweep, so the report counts these days as closed.
  // With no explicit day, sweeps BOTH IST-yesterday and IST-today: an African branch's 10pm falls
  // past IST midnight (NBO/DAR 00:30, FBM 01:30 IST), by which point their local date — the day
  // being closed — is already "yesterday" in IST terms.
  async autoCloseOpenDays(dateKey?: string): Promise<{ day: string; closed: number }> {
    const days = dateKey ? [dateKey] : [addDays(todayKey(), -1), todayKey()];
    let closed = 0;
    for (const day of days) closed += await this.autoCloseOpenDay(day);
    return { day: days.join(', '), closed };
  },

  async autoCloseOpenDay(day: string): Promise<number> {
    const open = await attendanceRepo.openForDay(day);
    if (!open.length) return 0;

    // Both the 10pm gate and the office-end stamp are branch-local, so resolve each open user's
    // working branch first — same rule as the day-close report: explicit assignment → first CRM
    // branch.
    const userIds = open.map((r) => r.userId);
    const workBranches = await userWorkBranches.mapFor(userIds);
    const userOids = userIds.filter((v) => Types.ObjectId.isValid(v)).map((v) => new Types.ObjectId(v));
    const users = userOids.length ? ((await crmRepo.listUsers({ _id: { $in: userOids } })) as CrmUser[]) : [];
    const firstBranch = new Map(users.map((u) => [String(u._id), String((u.branch_ids ?? [])[0] ?? '')]));
    const branchIdOf = (userId: string): string => workBranches[userId] ?? firstBranch.get(userId) ?? '';
    const branchOids = [...new Set(userIds.map(branchIdOf).filter((v) => Types.ObjectId.isValid(v)))].map((v) => new Types.ObjectId(v));
    const branches: CrmBranch[] = branchOids.length ? await crmRepo.branchesByIds(branchOids) : [];
    const closeByBranchId = new Map(branches.map((b) => [String(b._id), branchAutoClose(b)]));

    const now = new Date();
    let closed = 0;
    for (const r of open) {
      if (!r.checkInAt) continue; // defensive — the query already excludes these
      const { tz, stamp } = closeByBranchId.get(branchIdOf(r.userId)) ?? { tz: ATTENDANCE_TZ, stamp: AUTO_CLOSE_STAMP };
      if (!autoCloseDue(day, tz, now)) continue; // this branch hasn't reached its local 10pm yet
      const closeAt = resolveAutoCloseAt(day, r.checkInAt, stamp, tz);
      if (closeAt.getTime() > now.getTime()) continue; // defensive: never write a future checkout
      await attendanceRepo.upsert(r.userId, day, {
        checkOutAt: closeAt,
        method: 'Auto-closed',
        present: false,
      });
      closed += 1;
    }
    return closed;
  },

  // Daily attendance DAY-CLOSE report, branch-wise → the branch's GROUP CHAT.
  //
  // Where: "HQ - <CODE> Finance" (the hub posts to "MHUB - Finance Team"), the same groups the
  // daily finance reports land in. It used to post into the Attendance alert channels, which
  // existed for BOM and AMD alone — so Nairobi, Dar es Salaam, Lubumbashi and the hub, whose
  // people punch every day, were bucketed into a channel that did not exist and silently dropped.
  // Every branch has a group, so every branch now gets its report.
  //
  // When: 22:00 in the BRANCH's own night, not 22:00 IST. FBM's 10pm is 01:30 IST the NEXT
  // calendar day, which is why the day being reported is the branch-local one: at that instant
  // the IST clock has already rolled over, and reporting on the IST day would post an all-absent
  // summary for a day nobody has worked yet. The sweep ticks every minute through the window and
  // each branch self-gates here (autoCloseDue is the same 10pm-local predicate the auto-close
  // uses), so one tick loop serves every zone.
  //
  // Idempotent per (branch, day) through the chat post's own dedupe key, so ticking every minute
  // from 10pm posts exactly once and a restart cannot double-post. `force` (the admin/manual path)
  // skips both the hour gate and the dedupe.
  async dayCloseReport(opts: { dateKey?: string; only?: string; force?: boolean } = {}): Promise<{ day: string; posted: { branch: string; group: string; present: number; total: number }[] }> {
    const now = new Date();
    // Cheap early-out before the directory fan-out: is ANY branch at its own 10pm and still
    // unreported? Seven branch docs, versus every active user + their attendance, on each tick.
    if (!opts.force) {
      const due = (await crmRepo.listBranches({})).some((b) => {
        const code = attendanceBranchCode(b);
        if (!code || (opts.only && code !== String(opts.only).toUpperCase())) return false;
        const { tz } = branchAutoClose({ code });
        const day = opts.dateKey ?? dayKeyIn(tz, now);
        return autoCloseDue(day, tz, now) && !reportedTonight.has(`${code}:${day}`);
      });
      if (!due) return { day: opts.dateKey ?? todayKey(), posted: [] };
    }
    const users = (await crmRepo.listUsers({ status: 'active' })) as CrmUser[];
    const hiddenSet = await attendanceHidden.hiddenSet();
    const exempt = await attendanceExempt.exemptSet();
    const supers = superUserIds(users, await crmRepo.listRoles());
    // Hidden users are in no report at all: their attendance is private (owner call, 07-31).
    const tracked = users.filter((u) => !exempt.has(String(u._id)) && !supers.has(String(u._id)) && !hiddenSet.has(String(u._id)));

    // Working branch per user: explicit assignment → first CRM branch (same rule as the team view).
    const workBranches = await userWorkBranches.mapFor(tracked.map((u) => String(u._id)));
    const branchIdOf = (u: CrmUser): string => {
      const id = String(u._id);
      const first = (u.branch_ids ?? [])[0];
      return workBranches[id] ?? (first ? String(first) : '');
    };
    const branchOids = [...new Set(tracked.map(branchIdOf).filter((v) => Types.ObjectId.isValid(v)))].map((v) => new Types.ObjectId(v));
    const branches: CrmBranch[] = branchOids.length ? await crmRepo.branchesByIds(branchOids) : [];
    const branchById = new Map(branches.map((b) => [String(b._id), b]));

    // Bucket by reporting branch CODE (BOMMB/MUM and the city fallback resolve to Mumbai).
    const buckets = new Map<string, CrmUser[]>();
    for (const u of tracked) {
      const code = attendanceBranchCode(branchById.get(branchIdOf(u)) ?? null);
      if (!code) continue; // no resolvable branch → no report to belong to
      if (opts.only && code !== String(opts.only).toUpperCase()) continue;
      buckets.set(code, [...(buckets.get(code) ?? []), u]);
    }

    const posted: { branch: string; group: string; present: number; total: number }[] = [];
    let reportedDay = opts.dateKey ?? todayKey();

    for (const [branchCode, chUsers] of buckets) {
      const { tz } = branchAutoClose({ code: branchCode });
      // The branch's own calendar day and its own 10pm.
      const day = opts.dateKey ?? dayKeyIn(tz, now);
      reportedDay = day;
      if (!opts.force) {
        if (!autoCloseDue(day, tz, now)) continue; // this branch's night hasn't come yet
        if (reportedTonight.has(`${branchCode}:${day}`)) continue; // already attempted tonight
        reportedTonight.add(`${branchCode}:${day}`);
      }

      const records = await attendanceRepo.forUsersOnDay(day, chUsers.map((u) => String(u._id)));
      const byUser = new Map(records.map((r) => [r.userId, r]));
      // Per-user detail: name · check-in → check-out (or "still in") · via method — in the
      // BRANCH's wall clock, so Nairobi reads Nairobi times rather than IST.
      const presentRows: { name: string; line: string }[] = [];
      const absentNames: string[] = [];
      for (const u of chUsers) {
        const name = nameOf(u);
        const rec = byUser.get(String(u._id));
        if (rec?.checkInAt) {
          const inT = fmtTime(rec.checkInAt, tz) ?? '—';
          const outT = rec.checkOutAt ? `out ${fmtTime(rec.checkOutAt, tz)}` : 'still in';
          const via = rec.method ? ` · ${rec.method}` : '';
          presentRows.push({ name, line: `• ${name} — in ${inT} → ${outT}${via}` });
        } else {
          absentNames.push(name);
        }
      }
      presentRows.sort((a, b) => a.name.localeCompare(b.name));
      absentNames.sort();
      const total = chUsers.length;
      const presentCount = presentRows.length;

      const bodyLines: string[] = [`✅ Present ${presentCount}/${total}    ❌ Absent ${absentNames.length}`];
      if (presentRows.length) bodyLines.push('', 'PRESENT', ...presentRows.map((r) => r.line));
      if (absentNames.length) bodyLines.push('', 'ABSENT', ...absentNames.map((n) => `• ${n}`));

      try {
        const res = await reportChat.post({
          branchCode,
          group: 'finance', // the day's people-report belongs with the day's money-reports
          title: `🕘 Attendance · ${branchCode} · ${presentCount}/${total} present · ${day}`,
          body: bodyLines.join('\n'),
          ...(opts.force ? {} : { dedupeKey: `attendance-${branchCode}-${day}` }),
        });
        if (!res.duplicate) posted.push({ branch: branchCode, group: res.group, present: presentCount, total });
      } catch (e) {
        // A branch without a group (or a renamed one) must not take the other branches down with it.
        // eslint-disable-next-line no-console
        console.warn(`[attendance-dayclose] ${branchCode}: ${(e as Error).message}`);
      }
    }
    return { day: reportedDay, posted };
  },
};
