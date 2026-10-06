import { Types } from 'mongoose';
import { AppError, BadRequest, Forbidden, NotFound } from '../../common/errors';
import { accessService } from '../access';
import { crmRepo, type CrmUser } from '../crm.repo';
import { attendanceService, resolveAdminTimes } from '../attendance/attendance.service';
import { dayKeyIn } from '../attendance/attendanceBranch';
import { hrRepo, type HrLeaveApplicationDoc } from './hr.repo';
import { instantAt } from './attendanceMonth';
import { hrBranchCodeFor, nameOfUser, postToBranchHrAlerts } from './hrNotify';
import { sweepLeaveDecisions } from './leaveDecision.sweep';
import {
  branchTimezoneOf, chainOf, freshChain, ownerSignatures, toRegularizationDto, wallClockOf, type RegularizationDto,
} from './timeCorrection.rules';

// Attendance regularisation — a TIME CORRECTION: "I was in by 9:40, the app never fired" / "forgot
// to check out". Since 2026-10-06 the request is the SAME row the ERP's own "Correct time" files
// (hr_leave_applications, kind 'time' — see timeCorrection.rules), so it lands in the ERP's
// Approvals ▸ Leave tab the moment it is raised, signed there FM → Director → Owner, and in the
// Super Admin's queue here — whichever door decides it, the other reads the decision. Approval
// writes the day through attendanceService.applyAdminTimes — the same evidence-preserving
// correction the ERP's sheet planner makes (a real punch keeps its method/photos/fix; only the
// times move; the day is stamped adjustedBy/adjustedAt) — so history, team, the ERP calendar and
// the app's month view all read the corrected day identically.

const ATTENDANCE_TZ = process.env.ATTENDANCE_TZ || 'Asia/Kolkata';
const todayKeyOf = (now: Date): string => dayKeyIn(ATTENDANCE_TZ, now);
const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;
const addDays = (key: string, n: number): string => {
  const d = new Date(`${key}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

// Same look-back the leave ask gets — anything older is HR's to fix on the ERP report.
export const REGULARIZE_BACK_DAYS = 62;

// The three states the admin queue can be read in (the app's Pending / Approved / Rejected tabs).
// 'cancelled' is deliberately absent: a withdrawn request was never decided, so it belongs to the
// requester's own trail, not to the decision queue.
export const ADMIN_QUEUE_STATUSES = ['pending', 'approved', 'rejected'] as const;
export type AdminQueueStatus = (typeof ADMIN_QUEUE_STATUSES)[number];
export const asAdminQueueStatus = (v: unknown): AdminQueueStatus =>
  (ADMIN_QUEUE_STATUSES as readonly string[]).includes(String(v)) ? (v as AdminQueueStatus) : 'pending';

// What the ERP reads on a row the Super Admin approved here — the levels signed past say why.
export const APP_SIGN_PAST_REASON = 'Approved in the Smart Connect app by the Super Admin';

export interface RegularizationBody {
  date: string;
  checkInAt: string; // ISO instants (the device's clock — what the person picked is what is saved)
  checkOutAt?: string | null;
  reason?: string;
}

export type { RegularizationDto };

/** Pure planner (exported for tests): bounds a request before anything is stored. Times go
 *  through the SAME resolveAdminTimes bounds the admin editor gets — on the day, not in the
 *  future, out after in, only today may be left open. */
export function planRegularization(body: RegularizationBody, now: Date): { date: string; checkInAt: Date; checkOutAt: Date | null; reason: string } {
  const date = String(body.date || '').trim();
  const today = todayKeyOf(now);
  if (!DAY_KEY_RE.test(date)) throw BadRequest('Invalid date — expected YYYY-MM-DD');
  if (date > today) throw BadRequest('That day has not happened yet — regularisation is for past days');
  if (date < addDays(today, -REGULARIZE_BACK_DAYS)) throw BadRequest('That is too far back — ask HR to correct it on the attendance report');
  const reason = String(body.reason || '').trim().slice(0, 300);
  if (!reason) throw BadRequest('Say why — the reason goes to your manager with the request');
  const { checkInAt, checkOutAt } = resolveAdminTimes({ date, checkInAt: body.checkInAt, checkOutAt: body.checkOutAt ?? null }, now);
  return { date, checkInAt, checkOutAt, reason };
}

/** The clock a person's correction is keyed on — the ERP's rule (attendanceEdit.prepareDayEdit):
 *  their HR record's branch clock; a login with no HR record reads on head office's. */
export async function clockForPerson(userId: string, emp?: { branch?: string } | null): Promise<string> {
  const record = emp === undefined ? await hrRepo.employeeByUserId(userId) : emp;
  if (!record) return ATTENDANCE_TZ;
  const row = await hrRepo.branchRow(String(record.branch ?? '')).catch(() => null);
  return branchTimezoneOf(row, ATTENDANCE_TZ);
}

const fmtWall = (hhmm: string): string => {
  const m = /^(\d{2}):(\d{2})$/.exec(hhmm);
  if (!m) return hhmm || 'open';
  const h = Number(m[1]);
  return `${h % 12 || 12}:${m[2]} ${h < 12 ? 'AM' : 'PM'}`;
};

export const regularizationService = {
  /** GET /hr/regularizations — the caller's own trail, newest first. */
  async myRequests(userId: string): Promise<RegularizationDto[]> {
    const rows = await hrRepo.listTimeCorrections(userId);
    if (!rows.length) return [];
    const tz = await clockForPerson(userId);
    return rows.map((r) => toRegularizationDto(r, tz));
  },

  /** POST /hr/regularizations — file the ask. The row is the ERP's own time-correction row, so it
   *  is on Approvals ▸ Leave at once; nothing changes on the record until someone approves. */
  async request(userId: string, body: RegularizationBody): Promise<RegularizationDto> {
    const now = new Date();
    const plan = planRegularization(body, now);
    const user = await crmRepo.getUserById(userId);
    if (!user) throw NotFound('Session user not found');
    const emp = await hrRepo.employeeByUserId(userId);
    const waiting = await hrRepo.pendingTimeCorrection(userId, plan.date);
    if (waiting) throw new AppError(409, `A correction for ${plan.date} is already waiting — withdraw it to send a different one`, 'REGULARIZATION_PENDING');

    const branch = String(emp?.branch ?? '').trim().toUpperCase() || (await hrBranchCodeFor(userId));
    const tz = await clockForPerson(userId, emp);
    const { checkIn, checkOut } = wallClockOf(plan, tz);
    const doc = await hrRepo.insertLeaveApplication({
      userId,
      name: String(emp?.name ?? '').trim() || nameOfUser(user),
      branch,
      from: plan.date,
      to: plan.date,
      dayType: 'full',
      reason: plan.reason,
      status: 'pending',
      appliedAt: now,
      decidedBy: '',
      decidedAt: null,
      decisionNote: '',
      markedDays: [],
      skippedDays: [],
      chain: freshChain(),
      approvals: [],
      source: 'self',
      kind: 'time',
      toStatus: '',
      checkIn,
      checkOut,
      raisedBy: { userId: '', name: '', role: '' },
      createdAt: now,
      updatedAt: now,
      __v: 0,
    });

    void (async () => {
      const branchCode = branch || (await hrBranchCodeFor(userId));
      if (!branchCode) return;
      await postToBranchHrAlerts({
        branchCode,
        actorUserId: userId,
        source: 'Attendance',
        title: `🕒 ${doc.name} asked for a time correction · ${plan.date} (in ${fmtWall(checkIn)} · out ${checkOut ? fmtWall(checkOut) : 'open'})`,
        body: `Reason: ${plan.reason}\nSigned FM → Director → Owner on the ERP → Approvals ▸ Leave, or by the Super Admin in the app → Approvals.`,
        dedupeKey: `attendance-regularize-${String(doc._id)}`,
      });
    })();

    return toRegularizationDto(doc, tz);
  },

  /** PUT /hr/regularizations/:id/cancel — withdraw while still pending (only the asker). */
  async cancel(userId: string, id: string): Promise<RegularizationDto> {
    const ok = await hrRepo.cancelLeaveApplication(id, userId);
    const doc = await hrRepo.getTimeCorrection(id);
    if (!doc || doc.userId !== userId) throw NotFound('No such request');
    if (!ok) throw new AppError(409, `Already ${doc.status} — only a pending request can be withdrawn`, 'NOT_PENDING');
    return toRegularizationDto(doc, await clockForPerson(userId));
  },

  /** GET /hr/regularizations/pending[?status=] — the manager's queue, names attached.
   *  Super-admin only (route), and scoped to the viewer's tenant like every admin attendance read.
   *  `status` defaults to 'pending' (the queue's original, and only, meaning), so older clients that
   *  send no query keep the exact response they had. The decided tabs read newest-decided first —
   *  a settled request is looked up by "what did we just do", not by how long it waited. Rows the
   *  ERP's web "Correct time" filed are here too: one queue. */
  async pendingForAdmin(adminId: string, status: AdminQueueStatus = 'pending'): Promise<RegularizationDto[]> {
    const viewer = await accessService.accessForUserId(adminId);
    if (!viewer?.isSuper) throw Forbidden('Only the super admin can decide attendance corrections');
    const rows = await hrRepo.timeCorrectionsByStatus(status);
    if (!rows.length) return [];
    const userIds = [...new Set(rows.map((r) => String(r.userId)))];
    const ids = userIds.filter((id) => Types.ObjectId.isValid(id)).map((id) => new Types.ObjectId(id));
    const [users, withRecord] = await Promise.all([crmRepo.listUsers({ _id: { $in: ids } }), hrRepo.userIdsWithHrRecord(userIds)]);
    const byId = new Map<string, CrmUser>(users.map((u) => [String(u._id), u]));
    const tzByBranch = new Map<string, string>();
    const out: RegularizationDto[] = [];
    for (const r of rows) {
      const user = byId.get(String(r.userId));
      if (!user) continue; // login deleted — nothing to correct against
      if (viewer.tenantId && user.tenant_id && String(user.tenant_id) !== viewer.tenantId) continue;
      const branch = String(r.branch ?? '').trim().toUpperCase() || (await hrBranchCodeFor(String(r.userId)));
      let tz = ATTENDANCE_TZ;
      if (withRecord.has(String(r.userId))) {
        if (!tzByBranch.has(branch)) tzByBranch.set(branch, branchTimezoneOf(await hrRepo.branchRow(branch).catch(() => null), ATTENDANCE_TZ));
        tz = tzByBranch.get(branch) ?? ATTENDANCE_TZ;
      }
      out.push(toRegularizationDto(r, tz, { name: String(r.name ?? '').trim() || nameOfUser(user), branch }));
    }
    return out;
  },

  /** PUT /hr/regularizations/:id/decision { action, note } — the Super Admin decides. Approve writes the
   *  day through applyAdminTimes and signs the row as the OWNER level of the ERP's chain (the levels not
   *  yet signed are signed past, with the reason recorded, exactly as the ERP records a sign-past);
   *  reject needs a note the requester reads. The requester is told by the decision sweep. */
  async decide(adminId: string, id: string, body: { action: 'approve' | 'reject'; note?: string }): Promise<RegularizationDto> {
    const viewer = await accessService.accessForUserId(adminId);
    if (!viewer?.isSuper) throw Forbidden('Only the super admin can decide attendance corrections');
    const doc = await hrRepo.getTimeCorrection(id);
    if (!doc) throw NotFound('No such request');
    if (doc.status !== 'pending') throw new AppError(409, `Already ${doc.status}`, 'NOT_PENDING');
    const target = await crmRepo.getUserById(doc.userId);
    if (!target) throw BadRequest('User not found');
    if (viewer.tenantId && target.tenant_id && String(target.tenant_id) !== viewer.tenantId) throw Forbidden('User is outside your tenant');

    const note = String(body.note || '').trim().slice(0, 300);
    if (body.action === 'reject' && !note) throw BadRequest('Say why — the note goes back to the requester');
    const admin = await crmRepo.getUserById(adminId);
    const by = String(admin?.email || adminId);
    const now = new Date();
    const tz = await clockForPerson(doc.userId);

    let decided: boolean;
    if (body.action === 'approve') {
      const signatures = ownerSignatures(doc, { by, at: now, note, reason: APP_SIGN_PAST_REASON });
      if (!signatures) throw new AppError(409, 'This correction was just signed by someone else — reload it and look again', 'STALE');
      const checkInAt = instantAt(doc.from, String(doc.checkIn ?? ''), tz);
      if (!checkInAt) throw BadRequest('The check-in time on this request is not valid — reject it and ask again');
      const checkOutAt = doc.checkOut ? instantAt(doc.from, String(doc.checkOut), tz) : null;
      // Same bounds as the admin's own editor. An open-checkout request approved on a LATER day
      // trips "a past day needs a check-out time" — the admin then corrects the day with times
      // themselves (or the ERP's Owner does); the request stays pending so the context isn't lost.
      await attendanceService.applyAdminTimes(adminId, {
        userId: doc.userId,
        date: doc.from,
        checkInAt: checkInAt.toISOString(),
        checkOutAt: checkOutAt ? checkOutAt.toISOString() : null,
      });
      decided = await hrRepo.decideTimeCorrection(id, {
        status: 'approved', decidedBy: by, decidedAt: now, decisionNote: note, markedDays: [doc.from], skippedDays: [], chain: chainOf(doc),
      }, signatures);
    } else {
      decided = await hrRepo.decideTimeCorrection(id, { status: 'rejected', decidedBy: by, decidedAt: now, decisionNote: note }, []);
    }
    if (!decided) throw new AppError(409, 'This correction was decided on the ERP meanwhile — reload the queue', 'STALE');

    // The requester hears at once (the same sweep announces an ERP decision within a minute).
    void sweepLeaveDecisions().catch(() => undefined);

    const after = (await hrRepo.getTimeCorrection(id)) as HrLeaveApplicationDoc;
    return toRegularizationDto(after, tz, { name: String(after.name ?? '').trim() || nameOfUser(target), branch: after.branch || undefined });
  },
};
