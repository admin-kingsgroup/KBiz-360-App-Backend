import type { AttendanceRecord as PAtt, User as PUser } from '@prisma/client';
import { prisma } from '../../db/prisma';
import { BadRequest, Forbidden } from '../../common/errors';
import { writeAudit } from '../../common/audit';
import { accessService } from '../access/access.service';
import { computePresence, autoPunch, canFacePunch, facePunch } from '../../domain/logic/attendance';
import { fmtTime } from '../../domain/logic/format';
import type { AttendanceRecord as DomainAtt, Coords, OfficeGeo, PunchMethod } from '../../domain/types';

export interface PunchBody {
  wifiOn?: boolean;
  coords?: Coords | null;
  method?: 'auto' | 'face';
}

const ZERO_OFFICE: OfficeGeo = { lat: 0, lng: 0, radius: 0 };

function todayDate(): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

// Office geofence = the user's first branch (frontend attendance screen uses the user's branch).
// No branch (e.g. Super) → zero office; presence then relies on Wi-Fi/face only.
async function resolveOffice(user: PUser): Promise<{ office: OfficeGeo; wifi: string | null }> {
  const code = user.branches[0];
  if (!code) return { office: ZERO_OFFICE, wifi: null };
  const br = await prisma.branch.findUnique({ where: { code } });
  if (!br) return { office: ZERO_OFFICE, wifi: null };
  return { office: { lat: br.lat, lng: br.lng, radius: br.radius }, wifi: br.wifi };
}

// Today's REAL punch row (memberName null distinguishes it from the seeded team-dashboard rows).
async function loadToday(userId: string): Promise<{ row: PAtt | null; att: DomainAtt }> {
  const row = await prisma.attendanceRecord.findFirst({ where: { userId, memberName: null, date: todayDate() } });
  const att: DomainAtt = row
    ? { inTime: row.checkInAt, outTime: row.checkOutAt, via: (row.method as PunchMethod | null) }
    : { inTime: null, outTime: null, via: null };
  return { row, att };
}

function mapMe(row: PAtt) {
  return {
    date: row.date.toISOString().slice(0, 10),
    inTime: row.checkInAt,
    outTime: row.checkOutAt,
    via: row.method,
    present: row.present,
    latitude: row.latitude,
    longitude: row.longitude,
    distanceMeters: row.distanceMeters,
    wifiSsid: row.wifiSsid,
    faceVerified: row.faceVerified,
  };
}

async function persist(
  userId: string,
  row: PAtt | null,
  next: DomainAtt,
  presence: ReturnType<typeof computePresence>,
  body: PunchBody,
  wifi: string | null,
): Promise<PAtt> {
  const data = {
    checkInAt: next.inTime,
    checkOutAt: next.outTime,
    method: next.via,
    present: presence.present,
    latitude: body.coords?.lat ?? null,
    longitude: body.coords?.lng ?? null,
    distanceMeters: presence.distance,
    wifiSsid: body.wifiOn ? wifi : (row?.wifiSsid ?? null),
    faceVerified: body.method === 'face' ? true : (row?.faceVerified ?? null),
  };
  if (row) return prisma.attendanceRecord.update({ where: { id: row.id }, data });
  return prisma.attendanceRecord.create({ data: { userId, date: todayDate(), ...data } });
}

export const attendanceService = {
  async checkIn(userId: string, body: PunchBody, actorId: string) {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw Forbidden('Session user not found');
    const { office, wifi } = await resolveOffice(user);
    const presence = computePresence({ wifiOn: !!body.wifiOn, coords: body.coords ?? null, office });
    const { row, att } = await loadToday(userId);
    if (att.inTime) throw BadRequest('Already checked in today');

    const now = new Date();
    let next: DomainAtt;
    if (body.method === 'face') {
      if (!canFacePunch(presence.present, att, false)) throw BadRequest('Face punch not allowed — not at office');
      next = facePunch(att, now); // records inTime via 'Face'
    } else {
      const auto = autoPunch(att, presence.present, presence.viaNow, now);
      if (!auto) throw BadRequest('Not present at office — cannot check in');
      next = auto;
    }
    const saved = await persist(userId, row, next, presence, body, wifi);
    await writeAudit({ actorId, action: 'CHECK_IN', entity: 'AttendanceRecord', entityId: saved.id, after: mapMe(saved) });
    return mapMe(saved);
  },

  async checkOut(userId: string, body: PunchBody, actorId: string) {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw Forbidden('Session user not found');
    const { office, wifi } = await resolveOffice(user);
    const presence = computePresence({ wifiOn: !!body.wifiOn, coords: body.coords ?? null, office });
    const { row, att } = await loadToday(userId);
    if (!att.inTime) throw BadRequest('Not checked in');
    if (att.outTime) throw BadRequest('Already checked out');

    const now = new Date();
    let next: DomainAtt;
    if (body.method === 'face') {
      if (!canFacePunch(presence.present, att, false)) throw BadRequest('Face punch not allowed — not at office');
      next = facePunch(att, now); // records outTime
    } else {
      const auto = autoPunch(att, false, '', now); // explicit check-out = leaving (present=false transition)
      if (!auto) throw BadRequest('Cannot check out');
      next = auto;
    }
    const saved = await persist(userId, row, next, presence, body, wifi);
    await writeAudit({ actorId, action: 'CHECK_OUT', entity: 'AttendanceRecord', entityId: saved.id, after: mapMe(saved) });
    return mapMe(saved);
  },

  async me(userId: string) {
    const { row } = await loadToday(userId);
    if (!row) return { date: todayDate().toISOString().slice(0, 10), inTime: null, outTime: null, via: null, present: false };
    return mapMe(row);
  },

  // Super-Admin-only team dashboard (per data/team.ts). Returns the seeded snapshot rows.
  async team(userId: string) {
    const access = await accessService.accessForUserId(userId);
    if (!access?.isSuper) throw Forbidden('Team attendance is Super Admin only');
    const rows = await prisma.attendanceRecord.findMany({ where: { memberName: { not: null } }, orderBy: { createdAt: 'asc' } });
    return rows.map((r) => ({
      id: r.id,
      name: r.memberName,
      initials: r.memberInitials,
      color: r.memberColor,
      branch: r.branchLabel,
      in: fmtTime(r.checkInAt, null),
      out: fmtTime(r.checkOutAt, null),
      via: r.method ?? undefined,
    }));
  },
};
