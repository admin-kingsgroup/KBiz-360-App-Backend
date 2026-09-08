import { Types } from 'mongoose';
import { AppError, BadRequest, Forbidden, NotFound } from '../../common/errors';
import { accessService } from '../access';
import { crmRepo, type CrmUser } from '../crm.repo';
import { alertService } from '../alerts/alert.service';
import { attendanceService, resolveAdminTimes, branchAutoClose } from '../attendance/attendance.service';
import { dayKeyIn } from '../attendance/attendanceBranch';
import { RegularizationModel, type RegularizationDoc } from './regularization.model';
import { hrBranchCodeFor, nameOfUser, postToBranchHrGroup } from './hrNotify';

// Attendance regularisation: request → SUPER-ADMIN decision. This is the only way anybody but
// the super admin gets a recorded time changed (owner rule 2026-09-08) — including the case the
// feature exists for, a forgotten check-in or check-out. Approval writes the day through
// attendanceService.applyAdminTimes — the same evidence-preserving correction the super admin's
// own time editor uses (a real punch keeps its method/photos/fix; only the times move; the day is
// stamped adjustedBy/adjustedAt), so history/team/ERP all read the corrected day identically.

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

export interface RegularizationBody {
  date: string;
  checkInAt: string; // ISO instants (the device's clock — what the person picked is what is saved)
  checkOutAt?: string | null;
  reason?: string;
}

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

export interface RegularizationDto {
  id: string;
  userId: string;
  date: string;
  checkInAt: string;
  checkOutAt: string | null;
  reason: string;
  status: string;
  appliedAt: string;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionNote: string;
  name?: string;
  branch?: string;
}

const present = (doc: RegularizationDoc, extra?: { name?: string; branch?: string }): RegularizationDto => ({
  id: String(doc._id),
  userId: doc.userId,
  date: doc.dateKey,
  checkInAt: doc.checkInAt.toISOString(),
  checkOutAt: doc.checkOutAt ? doc.checkOutAt.toISOString() : null,
  reason: doc.reason,
  status: doc.status,
  appliedAt: (doc.appliedAt ?? doc.createdAt).toISOString(),
  decidedBy: doc.decidedBy,
  decidedAt: doc.decidedAt ? doc.decidedAt.toISOString() : null,
  decisionNote: doc.decisionNote ?? '',
  ...extra,
});

const fmtWall = (d: Date | null, tz: string): string => {
  if (!d) return 'open';
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit', hour12: true }).format(d);
  } catch {
    return d.toISOString();
  }
};

export const regularizationService = {
  /** GET /hr/regularizations — the caller's own trail, newest first. */
  async myRequests(userId: string): Promise<RegularizationDto[]> {
    const rows = await RegularizationModel().find({ userId }).sort({ appliedAt: -1 }).limit(50).lean();
    return rows.map((r) => present(r as RegularizationDoc));
  },

  /** POST /hr/regularizations — file a request for one day. */
  async request(userId: string, body: RegularizationBody): Promise<RegularizationDto> {
    const plan = planRegularization(body, new Date());
    const open = await RegularizationModel().findOne({ userId, dateKey: plan.date, status: 'pending' }).lean();
    if (open) throw new AppError(409, `You already have a pending request for ${plan.date} — withdraw it first to change the ask`, 'REGULARIZATION_PENDING');
    const doc = await RegularizationModel().create({
      userId,
      dateKey: plan.date,
      checkInAt: plan.checkInAt,
      checkOutAt: plan.checkOutAt,
      reason: plan.reason,
      status: 'pending',
      appliedAt: new Date(),
    });

    void (async () => {
      const user = await crmRepo.getUserById(userId);
      const branchCode = await hrBranchCodeFor(userId);
      if (!branchCode) return;
      const { tz } = branchAutoClose({ code: branchCode });
      await postToBranchHrGroup({
        branchCode,
        title: `🛠 ${nameOfUser(user)} asked to regularise ${plan.date} · in ${fmtWall(plan.checkInAt, tz)} · out ${fmtWall(plan.checkOutAt, tz)}`,
        body: `Reason: ${plan.reason}\nThe Super Admin can approve or reject it in the app → Attendance → Regularisations.`,
        dedupeKey: `attendance-regularize-${String(doc._id)}`,
      });
    })();

    return present(doc.toObject() as RegularizationDoc);
  },

  /** PUT /hr/regularizations/:id/cancel — withdraw while still pending (only the asker). */
  async cancel(userId: string, id: string): Promise<RegularizationDto> {
    if (!Types.ObjectId.isValid(id)) throw NotFound('No such request');
    const doc = await RegularizationModel().findOne({ _id: new Types.ObjectId(id), userId });
    if (!doc) throw NotFound('No such request');
    if (doc.status !== 'pending') throw new AppError(409, `Already ${doc.status} — only a pending request can be withdrawn`, 'NOT_PENDING');
    doc.status = 'cancelled';
    doc.decidedAt = new Date();
    await doc.save();
    return present(doc.toObject() as RegularizationDoc);
  },

  /** GET /hr/regularizations/pending — the manager's queue (oldest first), names attached.
   *  Super-admin only (route), and scoped to the viewer's tenant like every admin attendance read. */
  async pendingForAdmin(adminId: string): Promise<RegularizationDto[]> {
    const viewer = await accessService.accessForUserId(adminId);
    if (!viewer?.isSuper) throw Forbidden('Only the super admin can decide attendance corrections');
    const rows = (await RegularizationModel().find({ status: 'pending' }).sort({ appliedAt: 1 }).limit(200).lean()) as RegularizationDoc[];
    if (!rows.length) return [];
    const ids = [...new Set(rows.map((r) => r.userId))].filter((id) => Types.ObjectId.isValid(id)).map((id) => new Types.ObjectId(id));
    const users = await crmRepo.listUsers({ _id: { $in: ids } });
    const byId = new Map<string, CrmUser>(users.map((u) => [String(u._id), u]));
    const out: RegularizationDto[] = [];
    for (const r of rows) {
      const user = byId.get(r.userId);
      if (!user) continue; // login deleted — nothing to correct against
      if (viewer.tenantId && user.tenant_id && String(user.tenant_id) !== viewer.tenantId) continue;
      const branchCode = await hrBranchCodeFor(r.userId);
      out.push(present(r, { name: nameOfUser(user), branch: branchCode }));
    }
    return out;
  },

  /** PUT /hr/regularizations/:id/decision { action, note } — approve (writes the day through
   *  applyAdminTimes) or reject (note required). Tells the requester either way (My Alerts). */
  async decide(adminId: string, id: string, body: { action: 'approve' | 'reject'; note?: string }): Promise<RegularizationDto> {
    const viewer = await accessService.accessForUserId(adminId);
    if (!viewer?.isSuper) throw Forbidden('Only the super admin can decide attendance corrections');
    if (!Types.ObjectId.isValid(id)) throw NotFound('No such request');
    const doc = await RegularizationModel().findById(id);
    if (!doc) throw NotFound('No such request');
    if (doc.status !== 'pending') throw new AppError(409, `Already ${doc.status}`, 'NOT_PENDING');
    const target = await crmRepo.getUserById(doc.userId);
    if (!target) throw BadRequest('User not found');
    if (viewer.tenantId && target.tenant_id && String(target.tenant_id) !== viewer.tenantId) throw Forbidden('User is outside your tenant');

    const note = String(body.note || '').trim().slice(0, 300);
    if (body.action === 'reject' && !note) throw BadRequest('Say why — the note goes back to the requester');

    if (body.action === 'approve') {
      // Same bounds as the admin's own editor. An open-checkout request approved on a LATER day
      // trips "a past day needs a check-out time" — the admin then corrects the day with times
      // themselves; the request stays pending so the context isn't lost.
      await attendanceService.applyAdminTimes(adminId, {
        userId: doc.userId,
        date: doc.dateKey,
        checkInAt: doc.checkInAt.toISOString(),
        checkOutAt: doc.checkOutAt ? doc.checkOutAt.toISOString() : null,
      });
    }

    doc.status = body.action === 'approve' ? 'approved' : 'rejected';
    doc.decidedBy = adminId;
    doc.decidedAt = new Date();
    doc.decisionNote = note;
    await doc.save();

    void alertService
      .recordUserAlert(doc.userId, {
        source: 'Attendance',
        title: `Regularisation ${doc.status} · ${doc.dateKey}`,
        body: doc.status === 'approved' ? `Your times for ${doc.dateKey} were applied.` : `Note: ${note}`,
        context: 'Your attendance',
      })
      .catch(() => undefined);

    return present(doc.toObject() as RegularizationDoc);
  },
};
