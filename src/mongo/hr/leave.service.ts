import { AppError, NotFound } from '../../common/errors';
import { crmRepo } from '../crm.repo';
import { AttendanceModel } from '../attendance/attendance.model';
import { dayKeyIn } from '../attendance/attendanceBranch';
import { hrRepo, type HrLeaveApplicationDoc } from './hr.repo';
import { leaveBalance, spanDays, spansOverlap, validateApplication, type LeaveBalance, type LeaveDayEntry } from './leaveRules';
import { hrBranchCodeFor, nameOfUser, postToBranchHrGroup } from './hrNotify';

// Paid-leave SELF-SERVICE for the app: see your balance, apply, withdraw while pending.
// The application is ONLY the ask — it lands in the SAME hr_leave_applications collection the
// ERP's approval queue (/tk/hr-leave) reads, and nothing touches attendance or the balance until
// HR approves it there. The balance itself is derived on read, the ERP's own rule (leaveRules).

const ATTENDANCE_TZ = process.env.ATTENDANCE_TZ || 'Asia/Kolkata';
const todayKey = (): string => dayKeyIn(ATTENDANCE_TZ);
// Half-day asks are offered only once the ERP side understands dayType (its old validator
// strips the field, silently filing a FULL day) — flip HR_HALF_DAY=on after that merge deploys.
const HALF_DAY_ENABLED = process.env.HR_HALF_DAY === 'on';

export interface LeaveApplicationDto {
  id: string;
  from: string;
  to: string;
  dayType: 'full' | 'half';
  days: number;
  reason: string;
  status: string;
  appliedAt: string | null;
  decidedBy: string;
  decidedAt: string | null;
  decisionNote: string;
  markedDays: string[];
  skippedDays: { day: string; reason: string }[];
}

const presentApp = (doc: HrLeaveApplicationDoc): LeaveApplicationDto => ({
  id: String(doc._id),
  from: doc.from,
  to: doc.to,
  dayType: doc.dayType === 'half' ? 'half' : 'full',
  days: doc.dayType === 'half' ? 0.5 : spanDays(doc.from, doc.to).length,
  reason: doc.reason,
  status: doc.status,
  appliedAt: doc.appliedAt ? new Date(doc.appliedAt).toISOString() : null,
  decidedBy: doc.decidedBy ?? '',
  decidedAt: doc.decidedAt ? new Date(doc.decidedAt).toISOString() : null,
  decisionNote: doc.decisionNote ?? '',
  markedDays: doc.markedDays ?? [],
  skippedDays: doc.skippedDays ?? [],
});

/** The entries that actually draw the balance down — the ERP's leave.service rule verbatim:
 *  a FULL leave day the person punched on was WORKED (0 drawn); a HALF-DAY leave draws 0.5
 *  when the other half was worked (a punch exists) and a FULL day when it wasn't. Any check-in
 *  counts, admin 'Manual' rows included. Exported for myMonth.service — one drawdown rule. */
export async function leaveDaysFor(userId: string): Promise<LeaveDayEntry[]> {
  const rows = await hrRepo.leaveOverrides(userId);
  if (!rows.length) return [];
  let worked = new Set<string>();
  try {
    const punched = await AttendanceModel()
      .find({ userId, dateKey: { $in: rows.map((r) => r.day) }, checkInAt: { $ne: null } })
      .select('dateKey')
      .lean();
    worked = new Set(punched.map((p) => String(p.dateKey)));
  } catch {
    // app store unreadable → every recorded leave day counts (fail-toward-drawdown, like the ERP)
  }
  const out: LeaveDayEntry[] = [];
  for (const r of rows) {
    const wasWorked = worked.has(r.day);
    const weight = r.state === 'halfLeave' ? (wasWorked ? 0.5 : 1) : wasWorked ? 0 : 1;
    if (weight > 0) out.push({ day: r.day, weight });
  }
  return out.sort((a, b) => a.day.localeCompare(b.day));
}

export const leaveService = {
  /** GET /hr/my-leave — balance as at today + the person's application trail. */
  async myLeave(userId: string): Promise<{ today: string; hasRecord: boolean; balance: LeaveBalance | null; applications: LeaveApplicationDto[]; features: { halfDay: boolean } }> {
    const today = todayKey();
    const [emp, apps] = await Promise.all([hrRepo.employeeByUserId(userId), hrRepo.listLeaveApplications(userId)]);
    const balance = emp
      ? leaveBalance({
          ...(emp.leave ?? {}),
          dateOfJoining: emp.dateOfJoining ?? '',
          dateOfLeaving: emp.dateOfLeaving ?? '',
          asOf: today,
          leaveDays: await leaveDaysFor(userId),
        })
      : null;
    return { today, hasRecord: !!emp, balance, applications: apps.map(presentApp), features: { halfDay: HALF_DAY_ENABLED } };
  },

  /** POST /hr/my-leave — file the ask. Bounds + errors mirror the ERP's applyLeave exactly. */
  async applyLeave(userId: string, body: { from?: string; to?: string; reason?: string; dayType?: string }): Promise<LeaveApplicationDto> {
    const today = todayKey();
    const ask = validateApplication(body, { today });
    if (ask.dayType === 'half' && !HALF_DAY_ENABLED) throw new AppError(400, 'Half-day leave is not enabled yet — apply for a full day', 'HALF_DAY_OFF');
    const emp = await hrRepo.employeeByUserId(userId);
    if (!emp) throw new AppError(422, 'No HR record is linked to your login yet — ask HR to add you on the Employee Master first', 'NO_HR_RECORD');

    // One ask per day: a span sharing a day with a pending or approved application is a
    // duplicate, not a new request.
    const open = await hrRepo.openLeaveApplications(userId);
    const clash = open.find((a) => spansOverlap(a, ask));
    if (clash) throw new AppError(409, `Those dates overlap your ${clash.status} application ${clash.from} → ${clash.to}`, 'LEAVE_OVERLAP');

    const user = await crmRepo.getUserById(userId);
    const now = new Date();
    const doc = await hrRepo.insertLeaveApplication({
      userId,
      name: String(emp.name ?? '').trim() || nameOfUser(user),
      branch: String(emp.branch ?? '').trim().toUpperCase(),
      from: ask.from,
      to: ask.to,
      dayType: ask.dayType,
      reason: ask.reason,
      status: 'pending',
      appliedAt: now,
      decidedBy: '',
      decidedAt: null,
      decisionNote: '',
      markedDays: [],
      skippedDays: [],
      createdAt: now,
      updatedAt: now,
    });

    void (async () => {
      const branchCode = await hrBranchCodeFor(userId, emp.branch);
      if (!branchCode) return;
      const span = ask.from === ask.to ? ask.from : `${ask.from} → ${ask.to}`;
      await postToBranchHrGroup({
        branchCode,
        title: `📝 ${doc.name} applied for ${ask.dayType === 'half' ? 'a HALF-DAY of ' : ''}leave · ${span} (${ask.dayType === 'half' ? '0.5' : ask.days.length}d)`,
        body: `Reason: ${ask.reason}\nApprove or reject on the ERP → Leave Applications.`,
        dedupeKey: `leave-apply-${String(doc._id)}`,
      });
    })();

    return presentApp(doc);
  },

  /** PUT /hr/my-leave/:id/cancel — withdraw while still pending (only the asker, only pending). */
  async cancelLeave(userId: string, id: string): Promise<LeaveApplicationDto> {
    const ok = await hrRepo.cancelLeaveApplication(id, userId);
    if (!ok) {
      const doc = await hrRepo.getLeaveApplication(id);
      if (!doc || doc.userId !== userId) throw NotFound('No such leave application');
      throw new AppError(409, `Already ${doc.status} — only a pending application can be withdrawn`, 'NOT_PENDING');
    }
    const doc = await hrRepo.getLeaveApplication(id);
    if (!doc) throw NotFound('No such leave application');
    return presentApp(doc);
  },
};
