import { Types } from 'mongoose';
import { BadRequest, Forbidden } from '../../common/errors';
import { crmRepo, type CrmUser, type CrmBranch } from '../crm.repo';
import { accessService } from '../access';
import { attendanceRepo } from './attendance.repository';
import type { AttendanceDoc } from './attendance.model';

export interface PunchBody {
  wifiOn?: boolean;
  coords?: { lat: number; lng: number } | null;
  method?: 'auto' | 'face';
}

const PALETTE = ['#9A6CF0', '#4F8BFF', '#37B6A4', '#E8A13A', '#E3674E', '#0C0E14'];
const colorFor = (id: string): string => PALETTE[[...id].reduce((n, c) => n + c.charCodeAt(0), 0) % PALETTE.length];
const nameOf = (u: CrmUser): string => `${u.first_name ?? ''} ${u.last_name ?? ''}`.trim() || u.email || 'Unknown';
const initialsOf = (name: string): string => name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]).join('').toUpperCase() || '?';

const todayKey = (): string => new Date().toISOString().slice(0, 10); // UTC day
const todayDate = (): Date => { const d = new Date(); d.setUTCHours(0, 0, 0, 0); return d; };

function fmtTime(d: Date | null): string | null {
  if (!d) return null;
  let h = d.getHours();
  const m = d.getMinutes().toString().padStart(2, '0');
  const ap = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${h}:${m} ${ap}`;
}

function viaFor(body: PunchBody): string {
  if (body.method === 'face') return 'Face';
  if (body.wifiOn) return 'Wi-Fi';
  if (body.coords) return 'Geofence';
  return 'Auto';
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
  // POST /attendance/check-in — first punch of the day. The device has already determined presence.
  async checkIn(userId: string, body: PunchBody) {
    const key = todayKey();
    const today = await attendanceRepo.findToday(userId, key);
    if (today?.checkInAt) throw BadRequest('Already checked in today');
    const now = new Date();
    const saved = await attendanceRepo.upsert(userId, key, {
      date: todayDate(),
      checkInAt: now,
      method: viaFor(body),
      present: true,
      latitude: body.coords?.lat ?? null,
      longitude: body.coords?.lng ?? null,
      wifiSsid: body.wifiOn ? 'Office Wi-Fi' : null,
      faceVerified: body.method === 'face' ? true : null,
    });
    return mapMe(saved);
  },

  // POST /attendance/check-out — closes the day.
  async checkOut(userId: string, body: PunchBody) {
    const key = todayKey();
    const today = await attendanceRepo.findToday(userId, key);
    if (!today?.checkInAt) throw BadRequest('Not checked in');
    if (today.checkOutAt) throw BadRequest('Already checked out');
    const now = new Date();
    const saved = await attendanceRepo.upsert(userId, key, {
      checkOutAt: now,
      method: viaFor(body),
      present: false,
      faceVerified: body.method === 'face' ? true : today.faceVerified,
    });
    return mapMe(saved);
  },

  // GET /attendance/me — today's status.
  async me(userId: string) {
    return mapMe(await attendanceRepo.findToday(userId, todayKey()));
  },

  // GET /attendance/team — today's attendance for the people the viewer oversees.
  // Managers (super_admin / company_manager) see their tenant; others see just themselves.
  async team(userId: string) {
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

    const ids = users.map((u) => String(u._id));
    const records = await attendanceRepo.forUsersOnDay(todayKey(), ids);
    const byUser = new Map(records.map((r) => [r.userId, r]));

    // Resolve branch labels for the displayed users.
    const branchIds = [...new Set(users.flatMap((u) => (u.branch_ids ?? []).slice(0, 1).map(String)))]
      .filter((id) => Types.ObjectId.isValid(id)).map((id) => new Types.ObjectId(id));
    const branches: CrmBranch[] = branchIds.length ? await crmRepo.branchesByIds(branchIds) : [];
    const branchById = new Map(branches.map((b) => [String(b._id), b.code || b.name || '—']));

    return users
      .map((u) => {
        const id = String(u._id);
        const rec = byUser.get(id);
        const name = nameOf(u);
        const branchId = (u.branch_ids ?? [])[0] ? String((u.branch_ids ?? [])[0]) : '';
        return {
          id,
          name,
          initials: initialsOf(name),
          color: colorFor(id),
          branch: branchById.get(branchId) ?? '—',
          in: fmtTime(rec?.checkInAt ?? null),
          out: fmtTime(rec?.checkOutAt ?? null),
          via: rec?.method ?? undefined,
        };
      })
      .sort((a, b) => (b.in ? 1 : 0) - (a.in ? 1 : 0) || a.name.localeCompare(b.name)); // present first
  },
};
