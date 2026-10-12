import { AppError, NotFound } from '../../common/errors';
import { crmRepo } from '../crm.repo';
import { dayKeyIn } from '../attendance/attendanceBranch';
import { hrRepo } from './hr.repo';
import { validateApplication } from './leaveRules';
import { leaveClash } from './leave.service';
import { hrBranchCodeFor, nameOfUser, postToBranchHrAlerts } from './hrNotify';
import { freshChain } from './timeCorrection.rules';
import { toWfhDto, type WfhApplicationDto } from './swapRules';

// WORK FROM HOME (owner, 2026-10-12 — "apply for work from home so that on that day the employee is not marked absent,
// shows WFH and counts in present"). The ask is the ERP's own hr_leave_applications row, kind 'wfh', in the ERP model's
// exact shape — on Approvals ▸ HR at once, signed FM → Director → Owner there. The Owner's signature writes a 'wfh'
// override on each working day of the span: the day reads PRESENT (no punch needed, never late). Same bounds as leave;
// one ask per day across leave and WFH.

const ATTENDANCE_TZ = process.env.ATTENDANCE_TZ || 'Asia/Kolkata';
const todayKey = (): string => dayKeyIn(ATTENDANCE_TZ);

export const wfhService = {
  /** GET /hr/wfh — the caller's own WFH trail. */
  async myWfh(userId: string): Promise<{ applications: WfhApplicationDto[] }> {
    return { applications: (await hrRepo.listWfh(userId)).map(toWfhDto) };
  },

  /** POST /hr/wfh — file the ask. */
  async apply(userId: string, body: { from?: string; to?: string; reason?: string }): Promise<WfhApplicationDto> {
    const today = todayKey();
    const ask = validateApplication({ from: body.from, to: body.to, reason: body.reason }, { today });
    const emp = await hrRepo.employeeByUserId(userId);
    if (!emp) throw new AppError(422, 'No HR record is linked to your login yet — ask HR to add you on the Employee Master first', 'NO_HR_RECORD');
    const clash = leaveClash(await hrRepo.openLeaveApplications(userId), ask);
    if (clash) throw new AppError(409, `Those dates overlap your ${clash.status} ${clash.kind === 'wfh' ? 'work-from-home' : 'leave'} application ${clash.from} → ${clash.to}`, 'LEAVE_OVERLAP');

    const user = await crmRepo.getUserById(userId);
    const now = new Date();
    const doc = await hrRepo.insertLeaveApplication({
      userId,
      name: String(emp.name ?? '').trim() || nameOfUser(user),
      branch: String(emp.branch ?? '').trim().toUpperCase(),
      from: ask.from,
      to: ask.to,
      dayType: 'full',
      reason: ask.reason,
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
      kind: 'wfh',
      toStatus: '',
      checkIn: '',
      checkOut: '',
      raisedBy: { userId: '', name: '', role: '' },
      createdAt: now,
      updatedAt: now,
      __v: 0,
    });

    void (async () => {
      const branchCode = await hrBranchCodeFor(userId, emp.branch);
      if (!branchCode) return;
      const span = ask.from === ask.to ? ask.from : `${ask.from} → ${ask.to}`;
      await postToBranchHrAlerts({
        branchCode,
        actorUserId: userId,
        source: 'Work from home',
        title: `🏠 ${doc.name} asked to work from home · ${span} (${ask.days.length}d)`,
        body: `Reason: ${ask.reason}\nSigned FM → Director → Owner on the ERP → Approvals ▸ HR. Approved days count as present.`,
        dedupeKey: `wfh-apply-${String(doc._id)}`,
      });
    })();

    return toWfhDto(doc);
  },

  /** PUT /hr/wfh/:id/cancel — withdraw while still pending (only the asker). */
  async cancel(userId: string, id: string): Promise<WfhApplicationDto> {
    const before = await hrRepo.getLeaveApplication(id);
    if (!before || before.userId !== userId || before.kind !== 'wfh') throw NotFound('No such work-from-home application');
    const ok = await hrRepo.cancelLeaveApplication(id, userId);
    const doc = await hrRepo.getLeaveApplication(id);
    if (!doc) throw NotFound('No such work-from-home application');
    if (!ok) throw new AppError(409, `Already ${doc.status} — only a pending application can be withdrawn`, 'NOT_PENDING');
    return toWfhDto(doc);
  },
};
