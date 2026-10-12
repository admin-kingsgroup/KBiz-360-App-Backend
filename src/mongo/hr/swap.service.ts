import { Types } from 'mongoose';
import { AppError, BadRequest, NotFound } from '../../common/errors';
import { crmRepo } from '../crm.repo';
import { alertService } from '../alerts/alert.service';
import { dayKeyIn } from '../attendance/attendanceBranch';
import { employedOn } from './attendanceMonth';
import { hrRepo, type HrEmployeeDoc, type HrLeaveApplicationDoc } from './hr.repo';
import { hrBranchCodeFor, nameOfUser, postToBranchHrAlerts } from './hrNotify';
import { freshChain } from './timeCorrection.rules';
import {
  DAY_RE, mergeDayMaps, satLabel, sideOf, swapBusyByPerson, swapProblem, swapRuleOf, toSwapDto, upcomingSaturdays,
  type SwapRequestDto,
} from './swapRules';

// SATURDAY SWAP (owner, 2026-10-12 — "our employees have alternate Saturday week offs; give an option to request a swap so
// an employee can swap the Saturday week off with another employee"). Owner's choices: an EXCHANGE of two Saturdays (the
// applicant works one of their own week-off Saturdays and takes one of their working Saturdays off; the partner the other
// way round), the partner ACCEPTS in this app first, then FM → Director → Owner sign it on the ERP (LEAVE-GATE-07), whose
// Owner signature marks the four days. The ask is the ERP's own hr_leave_applications row, kind 'swap'.

const ATTENDANCE_TZ = process.env.ATTENDANCE_TZ || 'Asia/Kolkata';
const todayKey = (): string => dayKeyIn(ATTENDANCE_TZ);
const UPCOMING = 12;

const BUSY_LABEL: Record<string, string> = {
  leave: 'paid leave', halfLeave: 'half-day leave', wfh: 'work from home', weekOff: 'a week off granted by HR',
  optionalHoliday: 'an optional holiday', swapWork: 'already in a swap', swapOff: 'already in a swap',
};

export interface SwapOptions {
  today: string; hasRecord: boolean; saturdays: 'none' | 'all' | 'odd' | 'even'; canSwap: boolean; why: string;
  upcoming: { day: string; off: boolean; busy: string }[];
}

/** Day decisions (overrides + open swaps) per person on these days. */
async function decisionsOn(userIds: string[], days: string[], exceptSwapId = ''): Promise<Map<string, Map<string, string>>> {
  const [overrides, open] = await Promise.all([hrRepo.overridesOn(userIds, days), hrRepo.openSwapsTouching(userIds, days)]);
  const busy = swapBusyByPerson(open, exceptSwapId);
  const out = new Map<string, Map<string, string>>();
  for (const uid of userIds) {
    const own = new Map(overrides.filter((o) => String(o.userId) === uid).map((o) => [String(o.day), String(o.state)] as [string, string]));
    out.set(uid, mergeDayMaps(own, busy.get(uid)));
  }
  return out;
}

const hasAppAccess = (u: { access?: { app?: boolean }; status?: string } | null): boolean => !!u && u.access?.app === true && u.status !== 'inactive';

/** The applicant's half of the check alone (the partner side stands in as one that fits). */
function ownProblem(me: HrEmployeeDoc, mine: Map<string, string>, workDay: string, offDay: string, today: string): string {
  const anyone = { name: 'the partner', offByRule: (d: string) => d === offDay, overrides: new Map<string, string>() };
  return swapProblem({ workDay, offDay, mine: sideOf(me.name || 'You', me.weekOff, mine), theirs: anyone, today });
}

async function swapRow(id: string): Promise<HrLeaveApplicationDoc> {
  const doc = await hrRepo.getLeaveApplication(id);
  if (!doc || doc.kind !== 'swap') throw NotFound('No such swap request');
  return doc;
}

export const swapService = {
  /** GET /hr/swaps — the swaps the caller asked for, and the ones asked of them. */
  async list(userId: string): Promise<{ mine: SwapRequestDto[]; incoming: SwapRequestDto[] }> {
    const { mine, incoming } = await hrRepo.listSwaps(userId);
    return { mine: mine.map((d) => toSwapDto(d, userId)), incoming: incoming.map((d) => toSwapDto(d, userId)) };
  },

  /** GET /hr/swaps/options — the caller's next Saturdays, which are off, and which are already decided. */
  async options(userId: string): Promise<SwapOptions> {
    const today = todayKey();
    const emp = await hrRepo.employeeByUserId(userId);
    if (!emp) return { today, hasRecord: false, saturdays: 'none', canSwap: false, why: 'No HR record is linked to your login yet — ask HR to add you on the Employee Master first', upcoming: [] };
    const rule = swapRuleOf(emp.weekOff);
    const canSwap = rule === 'odd' || rule === 'even';
    const why = canSwap ? '' : rule === 'all'
      ? 'Every Saturday is your week off — there is no working Saturday to swap'
      : 'You work every Saturday — there is no Saturday week off to swap';
    const sats = upcomingSaturdays(today, UPCOMING);
    const mine = (await decisionsOn([userId], sats)).get(userId) ?? new Map<string, string>();
    const own = sideOf(emp.name || '', emp.weekOff);
    const upcoming = sats.map((day) => {
      const st = mine.get(day) ?? '';
      const off = st === 'swapOff' || st === 'weekOff' ? true : st === 'swapWork' ? false : own.offByRule(day);
      return { day, off, busy: st ? (BUSY_LABEL[st] ?? st) : '' };
    });
    return { today, hasRecord: true, saturdays: rule, canSwap, why, upcoming };
  },

  /** GET /hr/swaps/partners?workDay=&offDay= — colleagues of the caller's branch who work `workDay` and are off
   *  `offDay` under their own rule, with nothing decided or asked on either day, and who use the app. */
  async partners(userId: string, workDay: string, offDay: string): Promise<{ partners: { userId: string; name: string; position: string }[] }> {
    const today = todayKey();
    const me = await hrRepo.employeeByUserId(userId);
    if (!me) throw new AppError(422, 'No HR record is linked to your login yet — ask HR to add you on the Employee Master first', 'NO_HR_RECORD');
    const days = [workDay, offDay];
    const mineDecided = (await decisionsOn([userId], days)).get(userId) ?? new Map<string, string>();
    const problem = ownProblem(me, mineDecided, workDay, offDay, today);
    if (problem) throw BadRequest(problem);

    const colleagues = (await hrRepo.employeesOfBranch(String(me.branch ?? '')))
      .filter((e) => e.userId && String(e.userId) !== userId)
      .filter((e) => days.every((d) => employedOn(d, { dateOfJoining: e.dateOfJoining ?? '', dateOfLeaving: e.dateOfLeaving ?? '' })));
    if (!colleagues.length) return { partners: [] };
    const ids = colleagues.map((e) => String(e.userId));
    const decided = await decisionsOn([userId, ...ids], days);
    const mine = sideOf(me.name || '', me.weekOff, decided.get(userId));
    const fits = colleagues.filter((e) => !swapProblem({ workDay, offDay, mine, theirs: sideOf(e.name || '', e.weekOff, decided.get(String(e.userId))), today }));
    if (!fits.length) return { partners: [] };
    const users = await crmRepo.listUsers({ _id: { $in: fits.map((e) => String(e.userId)).filter((id) => Types.ObjectId.isValid(id)).map((id) => new Types.ObjectId(id)) } });
    const byId = new Map(users.map((u) => [String(u._id), u]));
    const partners = fits
      .filter((e) => hasAppAccess(byId.get(String(e.userId)) ?? null))
      .map((e) => ({ userId: String(e.userId), name: String(e.name ?? '').trim() || nameOfUser(byId.get(String(e.userId)) ?? null), position: String(e.designation ?? '') }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return { partners };
  },

  /** POST /hr/swaps — ask a colleague to swap. The partner is told at once and answers in the app. */
  async request(userId: string, body: { workDay?: string; offDay?: string; partnerUserId?: string; reason?: string }): Promise<SwapRequestDto> {
    const today = todayKey();
    const workDay = String(body.workDay ?? '').trim();
    const offDay = String(body.offDay ?? '').trim();
    const partnerUserId = String(body.partnerUserId ?? '').trim();
    const reason = String(body.reason ?? '').trim().slice(0, 500);
    if (!DAY_RE.test(workDay) || !DAY_RE.test(offDay)) throw BadRequest('Pick both Saturdays');
    if (!reason) throw BadRequest('Say why — the reason goes to your colleague and to the FM, the Director and the Owner');
    if (!partnerUserId || partnerUserId === userId) throw BadRequest('Pick the colleague you are swapping with');
    const [me, them, partnerUser, meUser] = await Promise.all([
      hrRepo.employeeByUserId(userId), hrRepo.employeeByUserId(partnerUserId), crmRepo.getUserById(partnerUserId), crmRepo.getUserById(userId),
    ]);
    if (!me) throw new AppError(422, 'No HR record is linked to your login yet — ask HR to add you on the Employee Master first', 'NO_HR_RECORD');
    if (!them) throw new AppError(422, 'That colleague has no HR record — a swap trades their week-off rule', 'NO_HR_RECORD');
    if (String(them.branch ?? '').toUpperCase() !== String(me.branch ?? '').toUpperCase()) throw BadRequest('Swap with a colleague of your own branch');
    if (!hasAppAccess(partnerUser)) throw BadRequest('That colleague does not use the Smart Connect app — they could not accept the swap');
    const myName = String(me.name ?? '').trim() || nameOfUser(meUser);
    const theirName = String(them.name ?? '').trim() || nameOfUser(partnerUser);
    const decided = await decisionsOn([userId, partnerUserId], [workDay, offDay]);
    const problem = swapProblem({ workDay, offDay, mine: sideOf(myName, me.weekOff, decided.get(userId)), theirs: sideOf(theirName, them.weekOff, decided.get(partnerUserId)), today });
    if (problem) throw BadRequest(problem);

    const now = new Date();
    const doc = await hrRepo.insertLeaveApplication({
      userId,
      name: myName,
      branch: String(me.branch ?? '').trim().toUpperCase(),
      from: workDay < offDay ? workDay : offDay,
      to: workDay < offDay ? offDay : workDay,
      dayType: 'full',
      reason,
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
      kind: 'swap',
      toStatus: '',
      checkIn: '',
      checkOut: '',
      raisedBy: { userId: '', name: '', role: '' },
      swap: {
        workDay, offDay, partnerUserId, partnerName: theirName, partnerBranch: String(them.branch ?? '').trim().toUpperCase(),
        partnerStatus: 'pending', partnerAt: null, partnerNote: '',
      },
      createdAt: now,
      updatedAt: now,
      __v: 0,
    });

    void alertService.recordUserAlert(partnerUserId, {
      source: 'HR',
      title: `🔁 ${myName} asks to swap Saturdays with you`,
      body: `You would be OFF on ${satLabel(workDay)} and WORK on ${satLabel(offDay)}.\nReason: ${reason}\nOpen HR ▸ Swap Saturday to accept or decline.`,
      context: 'Swap Saturday',
    }).catch(() => undefined);

    return toSwapDto(doc, userId);
  },

  /** PUT /hr/swaps/:id/respond — the partner accepts (it goes on to the FM) or declines (it closes). */
  async respond(userId: string, id: string, body: { accept?: boolean; note?: string }): Promise<SwapRequestDto> {
    const today = todayKey();
    const doc = await swapRow(id);
    const sw = doc.swap;
    if (!sw || String(sw.partnerUserId) !== userId) throw NotFound('No such swap request');
    if (doc.status !== 'pending' || sw.partnerStatus !== 'pending') throw new AppError(409, `Already ${doc.status === 'pending' ? sw.partnerStatus : doc.status}`, 'NOT_PENDING');
    const note = String(body.note ?? '').trim().slice(0, 300);
    const now = new Date();

    if (body.accept) {
      // Checked again — a Saturday may have been decided since it was asked.
      const [me, them] = await Promise.all([hrRepo.employeeByUserId(String(doc.userId)), hrRepo.employeeByUserId(userId)]);
      if (!me || !them) throw new AppError(422, 'An HR record is missing — a swap trades both week-off rules', 'NO_HR_RECORD');
      const decided = await decisionsOn([String(doc.userId), userId], [sw.workDay, sw.offDay], String(doc._id));
      const problem = swapProblem({ workDay: sw.workDay, offDay: sw.offDay, mine: sideOf(doc.name, me.weekOff, decided.get(String(doc.userId))), theirs: sideOf(sw.partnerName, them.weekOff, decided.get(userId)), today });
      if (problem) throw BadRequest(`This swap no longer stands — ${problem}`);
      const ok = await hrRepo.answerSwap(id, userId, { 'swap.partnerStatus': 'accepted', 'swap.partnerAt': now, 'swap.partnerNote': note });
      if (!ok) throw new AppError(409, 'This swap was withdrawn or answered meanwhile — reload it', 'STALE');
      void alertService.recordUserAlert(String(doc.userId), {
        source: 'HR',
        title: `🔁 ${sw.partnerName} accepted your Saturday swap`,
        body: `You work ${satLabel(sw.workDay)} and are off ${satLabel(sw.offDay)} once it is approved — it now goes to the FM, the Director and the Owner.`,
        context: 'Swap Saturday',
      }).catch(() => undefined);
      void (async () => {
        const branchCode = await hrBranchCodeFor(String(doc.userId), doc.branch);
        if (!branchCode) return;
        await postToBranchHrAlerts({
          branchCode,
          actorUserId: userId,
          source: 'Swap Saturday',
          title: `🔁 Saturday swap · ${doc.name} ⇄ ${sw.partnerName}`,
          body: `${doc.name} works ${satLabel(sw.workDay)} and is off ${satLabel(sw.offDay)}; ${sw.partnerName} the other way round. Both agreed — signed FM → Director → Owner on the ERP → Approvals ▸ HR.`,
          dedupeKey: `swap-accepted-${String(doc._id)}`,
        });
      })();
    } else {
      const ok = await hrRepo.answerSwap(id, userId, {
        status: 'rejected', decidedAt: now, decidedBy: sw.partnerName || userId, decidedRole: 'Partner',
        decisionNote: note || `Declined by ${sw.partnerName || 'the partner'}`,
        'swap.partnerStatus': 'declined', 'swap.partnerAt': now, 'swap.partnerNote': note,
      });
      if (!ok) throw new AppError(409, 'This swap was withdrawn or answered meanwhile — reload it', 'STALE');
      // The applicant hears of it from the decision sweep (a rejection), like every other decision.
    }
    return toSwapDto(await swapRow(id), userId);
  },

  /** PUT /hr/swaps/:id/cancel — the applicant withdraws it while it is still pending. */
  async cancel(userId: string, id: string): Promise<SwapRequestDto> {
    const before = await swapRow(id);
    if (String(before.userId) !== userId) throw NotFound('No such swap request');
    const ok = await hrRepo.cancelLeaveApplication(id, userId);
    const doc = await swapRow(id);
    if (!ok) throw new AppError(409, `Already ${doc.status} — only a pending swap can be withdrawn`, 'NOT_PENDING');
    const sw = doc.swap;
    if (sw?.partnerUserId) {
      void alertService.recordUserAlert(String(sw.partnerUserId), {
        source: 'HR',
        title: `🔁 ${doc.name} withdrew the Saturday swap`,
        body: `${satLabel(sw.workDay)} and ${satLabel(sw.offDay)} stay as your week-off rule has them.`,
        context: 'Swap Saturday',
      }).catch(() => undefined);
    }
    return toSwapDto(doc, userId);
  },
};
