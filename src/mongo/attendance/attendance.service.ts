import { Types } from 'mongoose';
import { BadRequest, Forbidden } from '../../common/errors';
import { crmRepo, type CrmUser, type CrmBranch } from '../crm.repo';
import { accessService, type MongoAccess } from '../access';
import { attendanceRepo } from './attendance.repository';
import { officeRepo } from './office.repository';
import { userOffices } from './userOffices';
import { userWorkBranches } from './userWorkBranches';
import { attendanceExempt } from '../attendanceExempt';
import { alertService } from '../alerts/alert.service';
import { attendanceChannelForBranch } from '../alerts/alertChannels';
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
// The UTC instant whose wall clock in the business timezone reads `dayKey hh:mm` (for admin
// corrections entered as business-local times). Two-step: format a UTC guess back into the tz,
// and shift by the difference.
const atBusinessTime = (dayKey: string, hhmm: string): Date => {
  const guess = new Date(`${dayKey}T${hhmm}:00.000Z`);
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: ATTENDANCE_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
  const wall = new Date(fmt.format(guess).replace(', ', 'T').replace(' ', 'T') + 'Z');
  return new Date(guess.getTime() - (wall.getTime() - guess.getTime()));
};
const todayDate = (): Date => new Date(`${todayKey()}T00:00:00.000Z`); // calendar-day marker for the record
function fmtTime(d: Date | null): string | null {
  if (!d) return null;
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: ATTENDANCE_TZ, hour: 'numeric', minute: '2-digit', hour12: true }).format(d);
  } catch {
    return null;
  }
}

// Hysteresis for geofence exits: an OS Exit only closes the day when the punch's own fix is at
// least this far BEYOND the office radius. Indoor GPS drift of 30–80 m is routine.
export const GEOFENCE_EXIT_BUFFER_M = 50;

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
async function isUntracked(userId: string): Promise<boolean> {
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
  };
}

export const attendanceService = {
  // Anti-spoofing gate for CHECK-IN — STRICT: the punch must come from INSIDE one of the user's
  // office geofences AND, when that office has a Wi-Fi SSID configured, from that office's Wi-Fi.
  // An office with no configured SSID stays geofence-only (so attendance isn't bricked before the
  // network is set up). If no office is configured at all, the punch is allowed unverified.
  async assertAtOffice(userId: string, body: PunchBody): Promise<{ distance: number | null; wifiVerified: boolean }> {
    const offices = await officesForUser(userId);
    if (!offices.length) return { distance: null, wifiVerified: false }; // nothing to validate against yet
    if (!body.coords) throw Forbidden('Location is required to record attendance — enable location and try again');
    const near = nearestOffice(offices, body.coords);
    if (!near || !near.within) {
      throw Forbidden(near ? `You must be at the office to check in — you are ${near.distance} m away` : 'You are not at a registered office');
    }
    // Wi-Fi leg: judge against the offices the user is actually INSIDE (overlapping fences count).
    const reported = normalizeSsid(body.wifiSsid);
    const insideOffices = offices.filter((o) => haversine(body.coords as Coords, { lat: o.lat, lng: o.lng }) <= o.radius);
    const wifiVerified = insideOffices.some((o) => !!normalizeSsid(o.wifiSsid) && normalizeSsid(o.wifiSsid) === reported);
    const wifiOk = insideOffices.some((o) => !normalizeSsid(o.wifiSsid) || normalizeSsid(o.wifiSsid) === reported);
    if (!wifiOk) throw Forbidden('You must be on the office Wi-Fi to check in');
    return { distance: near.distance, wifiVerified };
  },

  // POST /attendance/check-in — first punch of the day, OR a re-entry after a check-out.
  // Re-entry model: first-in stays, last-out wins. A check-in on an already-closed day (e.g. the
  // geofence drifted you out at lunch, or you left and came back) RE-OPENS it — checkOutAt clears,
  // presence resumes, the original checkInAt is preserved. This makes the day self-healing: any
  // spurious check-out is undone the moment presence at the office is proven again.
  async checkIn(userId: string, body: PunchBody) {
    if (await isUntracked(userId)) throw BadRequest('Attendance is not tracked for your account');
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
      faceVerified: body.method === 'face' ? true : (reopening ? today?.faceVerified ?? null : null),
    });
    // System alert ("X checked in") into the branch's attendance channel — fire-and-forget.
    void alertService.recordAttendancePunch(userId, 'in', now, saved?.method ?? null);
    return mapMe(saved);
  },

  // POST /attendance/check-out — closes the day. Allowed off-site (you may leave first), distance recorded.
  async checkOut(userId: string, body: PunchBody) {
    if (await isUntracked(userId)) throw BadRequest('Attendance is not tracked for your account');
    const key = todayKey();
    const today = await attendanceRepo.findToday(userId, key);
    if (!today?.checkInAt) throw BadRequest('Not checked in');
    if (today.checkOutAt) throw BadRequest('Already checked out');
    const now = new Date();
    const offices = await officesForUser(userId);
    const wifiVerified = wifiVerifiedFor(offices, body.wifiSsid);
    const distance = body.coords && offices.length ? (nearestOffice(offices, body.coords)?.distance ?? null) : null;
    // Drift rejection for GEOFENCE-fired check-outs only: GPS wobble indoors routinely produces OS
    // Exit events while the person is still at their desk. If the punch's own coordinates (or the
    // office Wi-Fi) prove they are still inside the fence (+hysteresis), the exit is noise — refuse
    // it. User-initiated check-outs are never blocked (leaving early from your desk is legitimate).
    if (body.source === 'geofence' && geofenceExitStillInside(offices, body.coords, wifiVerified)) {
      throw BadRequest('Still at the office — auto check-out ignored');
    }
    const saved = await attendanceRepo.upsert(userId, key, {
      checkOutAt: now,
      method: viaFor(body, wifiVerified),
      present: false,
      distanceMeters: distance ?? today.distanceMeters,
      faceVerified: body.method === 'face' ? true : today.faceVerified,
    });
    // System alert ("X checked out") into the branch's attendance channel — fire-and-forget.
    void alertService.recordAttendancePunch(userId, 'out', now, saved?.method ?? null);
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
      radius: body.radius ?? 150,
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
        ...audit,
      };
    } else {
      set = {
        date: new Date(`${body.date}T00:00:00.000Z`),
        checkInAt: null, checkOutAt: null, method: 'Manual', present: false,
        latitude: null, longitude: null, distanceMeters: null, wifiSsid: null, faceVerified: null,
        ...audit,
      };
    }
    return mapMe(await attendanceRepo.upsert(body.userId, body.date, set));
  },

  // GET /attendance/me — today's status.
  async me(userId: string) {
    const base = mapMe(await attendanceRepo.findToday(userId, todayKey()));
    return { ...base, exempt: await isUntracked(userId) };
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
    const exempt = await attendanceExempt.exemptSet();
    const supers = superUserIds(users, await crmRepo.listRoles());
    users = users.filter((u) => !exempt.has(String(u._id)) && !supers.has(String(u._id)));

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
        };
      })
      .sort((a, b) => (b.in ? 1 : 0) - (a.in ? 1 : 0) || a.name.localeCompare(b.name)); // present first
  },

  // Daily attendance DAY-CLOSE report, branch-wise. Groups every tracked (active, non-exempt) user
  // by the attendance channel of their working branch (BOM/AMD), tallies present vs absent for the
  // day, and posts one summary to each branch's attendance channel. Idempotent per (channel, day)
  // via alertService, so the 10pm sweep may safely re-run. Returns which channels it posted.
  async dayCloseReport(dateKey?: string): Promise<{ day: string; posted: { channelId: string; branch: string; present: number; total: number }[] }> {
    const day = dateKey ?? todayKey();
    const users = (await crmRepo.listUsers({ status: 'active' })) as CrmUser[];
    const exempt = await attendanceExempt.exemptSet();
    const supers = superUserIds(users, await crmRepo.listRoles());
    const tracked = users.filter((u) => !exempt.has(String(u._id)) && !supers.has(String(u._id)));

    // Working branch per user: explicit assignment → first CRM branch (same rule as the punch emitter).
    const workBranches = await userWorkBranches.mapFor(tracked.map((u) => String(u._id)));
    const branchIdOf = (u: CrmUser): string => {
      const id = String(u._id);
      const first = (u.branch_ids ?? [])[0];
      return workBranches[id] ?? (first ? String(first) : '');
    };
    const branchOids = [...new Set(tracked.map(branchIdOf).filter((v) => Types.ObjectId.isValid(v)))].map((v) => new Types.ObjectId(v));
    const branches: CrmBranch[] = branchOids.length ? await crmRepo.branchesByIds(branchOids) : [];
    const branchById = new Map(branches.map((b) => [String(b._id), b]));

    // Bucket users by their branch's attendance channel (BOMMB/city aliases resolve to BOM/AMD).
    const buckets = new Map<string, { branchCode: string; users: CrmUser[] }>();
    for (const u of tracked) {
      const channel = attendanceChannelForBranch(branchById.get(branchIdOf(u)) ?? null);
      if (!channel) continue;
      const b = buckets.get(channel.id) ?? { branchCode: channel.branchCode, users: [] };
      b.users.push(u);
      buckets.set(channel.id, b);
    }

    const records = await attendanceRepo.forUsersOnDay(day, tracked.map((u) => String(u._id)));
    const byUser = new Map(records.map((r) => [r.userId, r]));
    const posted: { channelId: string; branch: string; present: number; total: number }[] = [];

    for (const [channelId, { branchCode, users: chUsers }] of buckets) {
      if (await alertService.hasDayCloseReport(channelId, day)) continue; // already posted today
      // Per-user detail: name · check-in → check-out (or "still in") · via method.
      const presentRows: { name: string; line: string }[] = [];
      const absentNames: string[] = [];
      for (const u of chUsers) {
        const name = nameOf(u);
        const rec = byUser.get(String(u._id));
        if (rec?.checkInAt) {
          const inT = fmtTime(rec.checkInAt) ?? '—';
          const outT = rec.checkOutAt ? `out ${fmtTime(rec.checkOutAt)}` : 'still in';
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

      // Detailed report body (rendered in the alert detail screen): a per-user table split into
      // PRESENT (with times + method) and ABSENT.
      const bodyLines: string[] = [`✅ Present ${presentCount}/${total}    ❌ Absent ${absentNames.length}`];
      if (presentRows.length) bodyLines.push('', 'PRESENT', ...presentRows.map((r) => r.line));
      if (absentNames.length) bodyLines.push('', 'ABSENT', ...absentNames.map((n) => `• ${n}`));
      // The heads-up push stays short — the full table would be noise in a notification.
      const pushBody = `${presentCount}/${total} present · ${absentNames.length} absent — tap for the full report`;

      await alertService.recordDayClose(channelId, day, {
        title: `Day close · ${branchCode} · ${presentCount}/${total} present`,
        body: bodyLines.join('\n'),
        context: `TK ${branchCode} · Attendance`,
      }, pushBody);
      posted.push({ channelId, branch: branchCode, present: presentCount, total });
    }
    return { day, posted };
  },
};
