import { BadRequest, Forbidden } from '../../common/errors';
import { accessService } from '../access';
import { attendanceRepo } from '../attendance/attendance.repository';
import { attendanceService, trailExitSince, AUTO_PUNCH_ENABLED } from '../attendance/attendance.service';
import { dayKeyIn } from '../attendance/attendanceBranch';
import { officeRepo } from '../attendance/office.repository';
import { attendanceHidden } from '../attendanceHidden';
import { crmRepo } from '../crm.repo';
import { LocationLastModel, LocationPingModel, type LocationPingDoc } from './location.model';

// Work-hours location trail (owner ask, 2026-10-05): "I want the user's location all the time
// … in their check-in / check-out time, and I want it accurate." The device runs a background
// location-updates task from check-in to check-out and posts batches here. The SERVER is the
// authority on whether tracking is on: only fixes taken between today's check-in and check-out are
// stored; once the day is closed (or was never opened) the response says `tracking:false`, which
// makes the device stop its task (so a day closed by an admin, or the business day rolling over, ends
// tracking without the app being opened). Hidden (director) and untracked accounts never trail.
// The same stream also drives the AUTOMATIC CHECK-OUT (owner decision, 2026-10-05): see
// autoCheckOutFromTrail.

const ATTENDANCE_TZ = process.env.ATTENDANCE_TZ || 'Asia/Kolkata';
const todayKey = (): string => dayKeyIn(ATTENDANCE_TZ);
const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

// Fixes with a worse 68% radius than this are noise (cell-tower only, indoors with no GPS) and
// would draw a trail that jumps across the city. Dropped at ingest, so the stored trail is only
// what the admin can trust.
export const MAX_ACCURACY_M = Math.max(10, Number(process.env.LOCATION_MAX_ACCURACY_M ?? 250) || 250);
// A fix may legitimately predate the check-in by a little (the device batches before upload)
// and the device clock may run slightly ahead of the server's.
export const WINDOW_BEFORE_CHECK_IN_MS = 5 * 60_000;
export const WINDOW_FUTURE_MS = 2 * 60_000;

export interface PingInput {
  at: string; // ISO instant from the device
  lat: number;
  lng: number;
  accuracy?: number | null;
  speed?: number | null;
  heading?: number | null;
  altitude?: number | null;
  source?: 'bg' | 'fg';
}

export interface AcceptedPing {
  at: Date;
  lat: number;
  lng: number;
  accuracy: number | null;
  speed: number | null;
  heading: number | null;
  altitude: number | null;
  source: 'bg' | 'fg';
}

// Pure selection of the fixes worth storing: inside the attendance day's window, accurate enough,
// finite coordinates, one per instant (a device re-send carries the same `at`), in time order.
// The window ends at the check-out when the day is already closed: the device flushes its buffer
// right AFTER the check-out lands, and those fixes were taken while the person was still on duty.
export function selectPings(
  pings: PingInput[],
  window: { checkInAt: Date; checkOutAt?: Date | null; now: Date },
  maxAccuracy: number = MAX_ACCURACY_M,
): AcceptedPing[] {
  const from = window.checkInAt.getTime() - WINDOW_BEFORE_CHECK_IN_MS;
  const to = window.checkOutAt ? window.checkOutAt.getTime() : window.now.getTime() + WINDOW_FUTURE_MS;
  const byAt = new Map<number, AcceptedPing>();
  for (const p of pings) {
    const t = Date.parse(p.at);
    if (!Number.isFinite(t) || t < from || t > to) continue;
    if (!Number.isFinite(p.lat) || !Number.isFinite(p.lng)) continue;
    if (Math.abs(p.lat) > 90 || Math.abs(p.lng) > 180) continue;
    const acc = typeof p.accuracy === 'number' && Number.isFinite(p.accuracy) ? p.accuracy : null;
    if (acc !== null && acc > maxAccuracy) continue;
    const num = (v: number | null | undefined): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    byAt.set(t, { at: new Date(t), lat: p.lat, lng: p.lng, accuracy: acc, speed: num(p.speed), heading: num(p.heading), altitude: num(p.altitude), source: p.source === 'fg' ? 'fg' : 'bg' });
  }
  return [...byAt.values()].sort((a, b) => a.at.getTime() - b.at.getTime());
}

// Today's attendance day for a trailed account, or null when nothing may be stored at all (no
// check-in today, or a hidden director account). `checkOutAt` set = the day is closed: the device
// must stop, but fixes it took before that instant are still part of the day's trail.
async function trailDayFor(userId: string): Promise<{ dateKey: string; checkInAt: Date; checkOutAt: Date | null } | null> {
  if (await attendanceHidden.isHidden(userId)) return null;
  const today = await attendanceRepo.findToday(userId, todayKey());
  if (!today?.checkInAt) return null;
  return { dateKey: today.dateKey, checkInAt: today.checkInAt, checkOutAt: today.checkOutAt ?? null };
}

const pointOf = (p: Pick<LocationPingDoc, 'at' | 'lat' | 'lng' | 'accuracy' | 'speed'>) => ({
  at: p.at.toISOString(), lat: p.lat, lng: p.lng, accuracy: p.accuracy, speed: p.speed ?? null,
});

export const locationService = {
  // POST /location/pings — store a device batch. Returns how many were kept and whether the
  // device should keep its task running. NEVER throws for a closed day: the device must learn
  // `tracking:false` from a 200 so it can stop cleanly (an error would make it retry forever).
  async ingest(userId: string, pings: PingInput[]): Promise<{ accepted: number; tracking: boolean }> {
    const open = await trailDayFor(userId);
    if (!open) return { accepted: 0, tracking: false };
    const tracking = !open.checkOutAt; // closed day → keep what was taken on duty, then tell the device to stop
    const kept = selectPings(pings, { checkInAt: open.checkInAt, checkOutAt: open.checkOutAt, now: new Date() });
    if (!kept.length) return { accepted: 0, tracking };
    const access = await accessService.accessForUserId(userId);
    const tenantId = access?.tenantId ?? null;
    let accepted = 0;
    try {
      const res = await LocationPingModel().insertMany(
        kept.map((p) => ({ ...p, userId, tenantId, dateKey: open.dateKey })),
        { ordered: false },
      );
      accepted = res.length;
    } catch (e) {
      // ordered:false keeps going past duplicate-key rows (a re-sent batch); everything else rethrows.
      const err = e as { code?: number; insertedDocs?: unknown[]; result?: { insertedCount?: number } };
      if (err.code !== 11000 && !(err as { writeErrors?: { code: number }[] }).writeErrors?.every((w) => w.code === 11000)) throw e;
      accepted = err.insertedDocs?.length ?? err.result?.insertedCount ?? 0;
    }
    const last = kept[kept.length - 1];
    // Only move the last-known marker FORWARD — a late-arriving older batch must not rewind it.
    await LocationLastModel().updateOne(
      { userId, $or: [{ at: { $lt: last.at } }, { at: { $exists: false } }] },
      { $set: { tenantId, dateKey: open.dateKey, at: last.at, lat: last.lat, lng: last.lng, accuracy: last.accuracy } },
      { upsert: true },
    ).catch((e: { code?: number }) => { if (e.code !== 11000) throw e; /* row exists and is newer */ });
    // Automatic check-out from the trail: once the newest fixes show the person provably outside
    // every office for a few minutes, close the day at the instant they left. This is the accurate
    // half of automatic attendance — a stream of GPS fixes instead of one OS boundary event.
    if (tracking && (await this.autoCheckOutFromTrail(userId, open.dateKey))) return { accepted, tracking: false };
    return { accepted, tracking };
  },

  // Returns true when it closed the day. Never throws: a refused check-out (already closed by the
  // phone's own exit event, drift guard, account without an office) just means "not this time".
  async autoCheckOutFromTrail(userId: string, dateKey: string): Promise<boolean> {
    if (!AUTO_PUNCH_ENABLED) return false;
    try {
      const offices = await attendanceService.offices(userId);
      if (!offices.length) return false;
      const recent = await LocationPingModel().find({ userId, dateKey }).sort({ at: -1 }).limit(40).lean();
      const exit = trailExitSince(recent, offices);
      if (!exit) return false;
      await attendanceService.checkOut(userId, { method: 'auto', source: 'geofence', coords: exit.last, exitAt: exit.leftAt.toISOString() });
      return true;
    } catch {
      return false;
    }
  },

  // GET /location/live — the viewer's team (same scoping as the attendance team view: company-wide
  // managers see the tenant, branch managers their branches, everyone else only themselves) with
  // each person's last-known position and whether their trail is running right now.
  async live(viewerId: string) {
    const roster = await attendanceService.team(viewerId);
    const ids = roster.map((r) => r.id);
    const last = ids.length ? await LocationLastModel().find({ userId: { $in: ids } }).lean() : [];
    const byUser = new Map(last.map((l) => [l.userId, l]));
    const today = todayKey();
    return roster.map((r) => {
      const l = byUser.get(r.id);
      return {
        id: r.id,
        name: r.name,
        initials: r.initials,
        color: r.color,
        branch: r.branch,
        position: r.position ?? null,
        office: r.office,
        in: r.in,
        out: r.out,
        tracking: !!r.in && !r.out, // day open → the device should be streaming
        last: l ? { at: l.at.toISOString(), lat: l.lat, lng: l.lng, accuracy: l.accuracy, today: l.dateKey === today } : null,
      };
    });
  },

  // GET /location/trail/:userId?date= — one person's full trail for a business day, with the
  // day's punch times and the tenant's office circles for the map. The target must be someone
  // the viewer's team view covers on that day (same scoping as `live`).
  async trail(viewerId: string, targetUserId: string, dateKey?: string) {
    if (dateKey !== undefined && (!DAY_KEY_RE.test(dateKey) || dateKey > todayKey())) {
      throw BadRequest('Invalid date — expected YYYY-MM-DD, not in the future');
    }
    const day = dateKey ?? todayKey();
    const roster = await attendanceService.team(viewerId, day);
    const who = roster.find((r) => r.id === targetUserId);
    if (!who) throw Forbidden('That person is outside your team view');
    const viewer = await accessService.accessForUserId(viewerId);
    const target = await crmRepo.getUserById(targetUserId);
    if (!target) throw BadRequest('User not found');
    if (viewer?.tenantId && target.tenant_id && String(target.tenant_id) !== viewer.tenantId) throw Forbidden('User is outside your tenant');
    const [record, points, offices] = await Promise.all([
      attendanceRepo.findToday(targetUserId, day),
      LocationPingModel().find({ userId: targetUserId, dateKey: day }).sort({ at: 1 }).lean(),
      officeRepo.listByTenant(viewer?.tenantId ?? null),
    ]);
    return {
      userId: targetUserId,
      name: who.name,
      branch: who.branch,
      date: day,
      checkInAt: record?.checkInAt ? record.checkInAt.toISOString() : null,
      checkOutAt: record?.checkOutAt ? record.checkOutAt.toISOString() : null,
      tracking: day === todayKey() && !!record?.checkInAt && !record?.checkOutAt,
      points: points.map(pointOf),
      offices: offices.filter((o) => o.active !== false).map((o) => ({ id: String(o._id), label: o.label, lat: o.lat, lng: o.lng, radius: o.radius })),
    };
  },
};
