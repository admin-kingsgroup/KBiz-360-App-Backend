import { Types } from 'mongoose';
import { BadRequest, Forbidden } from '../../common/errors';
import { crmRepo, type CrmUser, type CrmBranch } from '../crm.repo';
import { accessService } from '../access';
import { attendanceRepo } from './attendance.repository';
import { officeRepo } from './office.repository';
import { userOffices } from './userOffices';
import { userWorkBranches } from './userWorkBranches';
import { attendanceExempt } from '../attendanceExempt';
import { userPositions } from '../userPositions';
import type { OfficeGeofenceDoc } from './office.model';
import type { AttendanceDoc } from './attendance.model';

export interface PunchBody {
  wifiOn?: boolean; // legacy client flag — ignored (never verifiable)
  wifiSsid?: string | null; // the Wi-Fi network the device is actually connected to
  coords?: { lat: number; lng: number } | null;
  method?: 'auto' | 'face';
}

const PALETTE = ['#9A6CF0', '#4F8BFF', '#37B6A4', '#E8A13A', '#E3674E', '#0C0E14'];
const colorFor = (id: string): string => PALETTE[[...id].reduce((n, c) => n + c.charCodeAt(0), 0) % PALETTE.length];
const nameOf = (u: CrmUser): string => `${u.first_name ?? ''} ${u.last_name ?? ''}`.trim() || u.email || 'Unknown';
const initialsOf = (name: string): string => name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]).join('').toUpperCase() || '?';

// Punch times are stored in UTC. The attendance DAY and the team view are computed in a FIXED business
// timezone (default IST) so a punch at e.g. 1 AM IST files under the correct local day (not the previous
// UTC day), and times read as the real wall-clock. Override with the ATTENDANCE_TZ env var if HQ moves.
const ATTENDANCE_TZ = process.env.ATTENDANCE_TZ || 'Asia/Kolkata';
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
  // Anti-spoofing gate for CHECK-IN: when offices are configured for the user, the punch must come
  // either from the office Wi-Fi (device SSID matches the office's configured SSID) or from inside
  // one of their geofences. Wi-Fi match alone is enough — indoor GPS is often off by more than the
  // radius. If no office is configured yet, the punch is allowed unverified so attendance isn't bricked.
  async assertAtOffice(userId: string, body: PunchBody): Promise<{ distance: number | null; wifiVerified: boolean }> {
    const offices = await officesForUser(userId);
    if (!offices.length) return { distance: null, wifiVerified: false }; // nothing to validate against yet
    const near = body.coords ? nearestOffice(offices, body.coords) : null;
    if (wifiVerifiedFor(offices, body.wifiSsid)) return { distance: near?.distance ?? null, wifiVerified: true };
    if (!body.coords) throw Forbidden('Location is required to record attendance — enable location and try again');
    if (!near || !near.within) {
      throw Forbidden(near ? `You must be at the office to check in — you are ${near.distance} m away` : 'You are not at a registered office');
    }
    return { distance: near.distance, wifiVerified: false };
  },

  // POST /attendance/check-in — first punch of the day. Validated against the user's office geofence.
  async checkIn(userId: string, body: PunchBody) {
    if (await attendanceExempt.isExempt(userId)) throw BadRequest('Attendance is not tracked for your account');
    const key = todayKey();
    const today = await attendanceRepo.findToday(userId, key);
    if (today?.checkInAt) throw BadRequest('Already checked in today');
    const { distance, wifiVerified } = await this.assertAtOffice(userId, body);
    const now = new Date();
    const saved = await attendanceRepo.upsert(userId, key, {
      date: todayDate(),
      checkInAt: now,
      method: viaFor(body, wifiVerified),
      present: true,
      latitude: body.coords?.lat ?? null,
      longitude: body.coords?.lng ?? null,
      distanceMeters: distance,
      wifiSsid: wifiVerified ? cleanSsid(body.wifiSsid) : null,
      faceVerified: body.method === 'face' ? true : null,
    });
    return mapMe(saved);
  },

  // POST /attendance/check-out — closes the day. Allowed off-site (you may leave first), distance recorded.
  async checkOut(userId: string, body: PunchBody) {
    if (await attendanceExempt.isExempt(userId)) throw BadRequest('Attendance is not tracked for your account');
    const key = todayKey();
    const today = await attendanceRepo.findToday(userId, key);
    if (!today?.checkInAt) throw BadRequest('Not checked in');
    if (today.checkOutAt) throw BadRequest('Already checked out');
    const now = new Date();
    const offices = await officesForUser(userId);
    const wifiVerified = wifiVerifiedFor(offices, body.wifiSsid);
    const distance = body.coords && offices.length ? (nearestOffice(offices, body.coords)?.distance ?? null) : null;
    const saved = await attendanceRepo.upsert(userId, key, {
      checkOutAt: now,
      method: viaFor(body, wifiVerified),
      present: false,
      distanceMeters: distance ?? today.distanceMeters,
      faceVerified: body.method === 'face' ? true : today.faceVerified,
    });
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
    return { ...base, exempt: await attendanceExempt.isExempt(userId) };
  },

  // GET /attendance/team — attendance for the people the viewer oversees, for one calendar
  // day (?date=YYYY-MM-DD, business-tz; defaults to today — lets the admin browse past days).
  // Managers (super_admin / company_manager) see their tenant; others see just themselves.
  async team(userId: string, dateKey?: string) {
    if (dateKey !== undefined && (!DAY_KEY_RE.test(dateKey) || dateKey > todayKey())) {
      throw BadRequest('Invalid date — expected YYYY-MM-DD, not in the future');
    }
    const day = dateKey ?? todayKey();
    const viewer = await accessService.accessForUserId(userId);
    if (!viewer) throw Forbidden('Session user not found');

    let users: CrmUser[];
    if (viewer.canManage) {
      const filter: Record<string, unknown> = { status: 'active' };
      if (viewer.tenantId && Types.ObjectId.isValid(viewer.tenantId)) filter.tenant_id = new Types.ObjectId(viewer.tenantId);
      users = await crmRepo.listUsers(filter);
    } else {
      const self = await crmRepo.getUserById(userId);
      users = self ? [self] : [];
    }

    // Drop attendance-exempt people (owners/directors who don't punch) from the tracked team list.
    const exempt = await attendanceExempt.exemptSet();
    users = users.filter((u) => !exempt.has(String(u._id)));

    const ids = users.map((u) => String(u._id));
    const records = await attendanceRepo.forUsersOnDay(day, ids);
    const byUser = new Map(records.map((r) => [r.userId, r]));

    // Each user's WORKING branch: explicit assignment → first CRM access branch.
    const workBranches = await userWorkBranches.mapFor(ids);
    const workBranchOf = (u: CrmUser): string => {
      const id = String(u._id);
      return workBranches[id] ?? ((u.branch_ids ?? [])[0] ? String((u.branch_ids ?? [])[0]) : '');
    };

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
};
