import { AttendanceModel } from '../attendance/attendance.model';
import { attendanceExempt } from '../attendanceExempt';
import { dayKeyIn } from '../attendance/attendanceBranch';
import { crmRepo } from '../crm.repo';
import { hrRepo, type HolidayEntry, type HrEmployeeDoc } from './hr.repo';
import { hrBranchCodeFor, nameOfUser } from './hrNotify';
import { leaveDaysFor } from './leave.service';
import { leaveBalance, type LeaveBalance } from './leaveRules';
import {
  applyNoData, buildMonth, isMonthKey, monthDayKeys, monthOf, summarizeMonth,
  WEEK_OFF_DAYS, type ClassifiedDay, type DayOverride, type DayRecord, type HolidayInfo, type MonthSummary,
} from './attendanceMonth';
import { daysOf, earnedOf, grossOf, ptExplain, ptForMonth, ptSchedule, recoveryFor, rupee, type LoanRecoveryLine, type PayDays } from './payRules';

// Self-service month views: My Attendance (the muster), My Payslip (the same month priced the
// way the ERP salary register prices it), and the branch holiday list. All identity comes from
// the JWT; everything is READ — the ERP owns the HR semantics, the app owns the punches.

const ATTENDANCE_TZ = process.env.ATTENDANCE_TZ || 'Asia/Kolkata';
const todayKey = (): string => dayKeyIn(ATTENDANCE_TZ);
// The head-office holiday country when a branch has none keyed (the ERP resolves this from its
// trading-branch registry; the group's HO is India).
const HOME_COUNTRY = (process.env.HR_HOME_COUNTRY || 'IN').toUpperCase();

async function firstPunchDayOf(userId: string): Promise<string> {
  try {
    const row = await AttendanceModel().findOne({ userId, checkInAt: { $ne: null } }).sort({ dateKey: 1 }).select('dateKey').lean();
    return row ? String(row.dateKey) : '';
  } catch { return ''; }
}

async function holidayMapFor(branch: string, year: number): Promise<Map<string, HolidayInfo>> {
  const country = (await hrRepo.branchCountry(branch)) || HOME_COUNTRY;
  const doc = await hrRepo.holidayList(country, year).catch(() => null);
  return new Map(((doc && doc.holidays) || []).map((h) => [h.date, { name: h.name, kind: h.kind === 'optional' ? 'optional' as const : 'closed' as const, movable: h.movable === true }]));
}


interface AssembledMonth {
  month: string;
  today: string;
  emp: HrEmployeeDoc | null;
  branch: string;
  days: ClassifiedDay[];
  summary: MonthSummary;
  leaveBal: LeaveBalance | null;
  firstPunchDay: string;
  beforeFirstPunch: boolean;
  exempt: boolean;
}

/** One person's classified month — shared by My Attendance and My Payslip. */
async function assembleMonth(userId: string, asked: string): Promise<AssembledMonth> {
  const today = todayKey();
  const month = isMonthKey(asked) ? asked : monthOf(today);
  const dayKeys = monthDayKeys(month);
  const from = dayKeys[0];
  const to = dayKeys[dayKeys.length - 1];

  const [emp, exempt] = await Promise.all([hrRepo.employeeByUserId(userId), attendanceExempt.isExempt(userId)]);
  const branch = String(emp?.branch ?? '').trim().toUpperCase() || (await hrBranchCodeFor(userId));

  const [rows, holidayByDay, overrides, firstPunch, leaveDays] = await Promise.all([
    AttendanceModel().find({ userId, dateKey: { $gte: from, $lte: to } }).lean(),
    holidayMapFor(branch, Number(month.slice(0, 4))).catch(() => new Map<string, HolidayInfo>()),
    hrRepo.overridesForRange(userId, from, to).catch(() => []),
    firstPunchDayOf(userId),
    leaveDaysFor(userId).catch(() => []),
  ]);

  const recordsByDay = new Map<string, DayRecord>(rows.map((r) => [String(r.dateKey), r as DayRecord]));
  const overridesByDay = new Map<string, DayOverride>(overrides.map((o) => [String(o.day), { state: o.state }]));
  const employment = { dateOfJoining: emp?.dateOfJoining || '', dateOfLeaving: emp?.dateOfLeaving || '' };

  const built = buildMonth(month, {
    recordsByDay, holidayByDay, overridesByDay, today, employment,
    policy: emp?.weekOff ?? null, shift: emp?.shift ?? null,
  });
  const days = applyNoData(built, { firstPunchDay: firstPunch });
  const summary = summarizeMonth(days);

  // The balance is "as at the end of the month shown" — the same figure the ERP drawer reads.
  const leaveBal = emp
    ? leaveBalance({ ...(emp.leave ?? {}), dateOfJoining: emp.dateOfJoining ?? '', dateOfLeaving: emp.dateOfLeaving ?? '', asOf: `${month}-01`, leaveDays })
    : null;

  const beforeFirstPunch = !!firstPunch && dayKeys.length > 0 && to < firstPunch;
  return { month, today, emp, branch, days, summary, leaveBal, firstPunchDay: firstPunch, beforeFirstPunch, exempt };
}

const dayOut = (d: ClassifiedDay) => ({
  ...d,
  checkInAt: d.checkInAt ? new Date(d.checkInAt).toISOString() : null,
  checkOutAt: d.checkOutAt ? new Date(d.checkOutAt).toISOString() : null,
});

export const myMonthService = {
  /** GET /hr/my-attendance?month= — the caller's own muster (never anyone else's). */
  async myAttendance(userId: string, asked: string) {
    const a = await assembleMonth(userId, asked);
    return {
      month: a.month,
      today: a.today,
      tz: ATTENDANCE_TZ,
      weekOffDays: WEEK_OFF_DAYS,
      employee: {
        name: String(a.emp?.name ?? '').trim() || nameOfUser(await crmRepo.getUserById(userId)),
        designation: a.emp?.designation ?? '',
        branch: a.branch,
        hasRecord: !!a.emp,
        dateOfJoining: a.emp?.dateOfJoining ?? '',
        dateOfLeaving: a.emp?.dateOfLeaving ?? '',
        weekOff: a.emp?.weekOff ?? null,
        shift: a.emp?.shift ?? null,
      },
      leaveBalance: a.leaveBal,
      exempt: a.exempt,
      days: a.days.map(dayOut),
      summary: a.summary,
      firstPunchDay: a.firstPunchDay,
      beforeFirstPunch: a.beforeFirstPunch,
    };
  },

  /** GET /hr/my-payslip?month= — the caller's OWN month, priced the salary-register way.
   *  Indicative until HR pays it — nothing here posts, and the register remains the truth. */
  async myPayslip(userId: string, asked: string) {
    const a = await assembleMonth(userId, asked);
    const emp = a.emp;
    const salary = emp?.salary ?? {};
    const gross = grossOf(salary);
    const structured = gross > 0;
    const d: PayDays = daysOf(a.summary);
    const earned = structured ? earnedOf(salary, d.payableDays, d.calendarDays) : { basic: 0, hra: 0, otherAllowance: 0, total: 0 };

    const pt = ptSchedule(emp?.pt ?? {}, emp?.gender ?? '', gross);
    const computed = { ptMonthly: pt.monthly, ptFebruary: pt.feb };
    const ptThisMonth = ptForMonth(computed, a.month, earned.total);
    const tds = earned.total > 0 && emp?.tds?.applicable ? Math.max(0, Number(emp.tds.monthly) || 0) : 0;

    const loans = await hrRepo.staffLoansFor(userId).catch(() => []);
    const recovery = recoveryFor(loans.map((l) => ({ ...l, id: String(l._id) })), a.month);
    const roomForLoans = Math.max(0, earned.total - ptThisMonth - tds);
    const loanRecovered = rupee(Math.min(recovery.due, roomForLoans));
    const loanShortfall = rupee(Math.max(0, recovery.due - loanRecovered));
    const totalDeduction = rupee(ptThisMonth + tds + loanRecovered);

    return {
      month: a.month,
      hasRecord: !!emp,
      structured,
      indicative: true, // the ERP salary register is the payroll truth — this is the same math, shown to its owner
      employee: {
        name: String(emp?.name ?? '').trim() || nameOfUser(await crmRepo.getUserById(userId)),
        empCode: emp?.empCode ?? '',
        designation: emp?.designation ?? '',
        branch: a.branch,
      },
      days: d,
      salary: { basic: Number(salary.basic) || 0, hra: Number(salary.hra) || 0, otherAllowance: Number(salary.otherAllowance) || 0, gross },
      earned,
      deductions: {
        pt: ptThisMonth,
        ptNote: structured ? ptExplain(emp?.pt ?? {}, emp?.gender ?? '', gross) : '',
        tds,
        loanRecovered,
        loanShortfall,
        loanLines: recovery.lines.filter((l: LoanRecoveryLine) => l.due > 0 || l.opening > 0),
        total: totalDeduction,
      },
      netPay: rupee(earned.total - totalDeduction),
      lopAmount: structured ? Math.max(0, rupee(gross - earned.total)) : 0,
      leaveBalance: a.leaveBal,
      payMode: emp?.payment?.mode ?? '',
    };
  },

  /** GET /hr/holidays?year= — the published notice for the caller's branch country. */
  async myHolidays(userId: string, askedYear: string) {
    const emp = await hrRepo.employeeByUserId(userId);
    const branch = String(emp?.branch ?? '').trim().toUpperCase() || (await hrBranchCodeFor(userId));
    const year = /^\d{4}$/.test(askedYear) ? Number(askedYear) : Number(todayKey().slice(0, 4));
    const country = (await hrRepo.branchCountry(branch)) || HOME_COUNTRY;
    const doc = await hrRepo.holidayList(country, year);
    const weekdayOf = (date: string): string => new Date(`${date}T00:00:00Z`).toLocaleDateString('en-GB', { weekday: 'long', timeZone: 'UTC' });
    const rows = ((doc && doc.holidays) || [])
      .map((h: HolidayEntry) => ({ ...h, movable: h.movable === true, weekday: weekdayOf(h.date) }))
      .sort((x, y) => x.date.localeCompare(y.date));
    return {
      year,
      country,
      branch: branch || 'ALL',
      published: !!doc,
      holidays: rows,
      notice: doc ? { issuedBy: doc.issuedBy ?? '', issuedOn: doc.issuedOn ?? '', company: doc.company ?? '', notes: doc.notes ?? [] } : null,
      today: todayKey(),
    };
  },
};
