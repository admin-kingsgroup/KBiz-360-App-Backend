import { BadRequest } from '../../common/errors';

// Paid-leave math — a FAITHFUL PORT of the ERP's src/features/hr/employee.rules.js (leave half)
// and leaveApplication.service.js (pure half). The two backends read the SAME collections
// (hr_employees, hr_attendance_overrides, hr_leave_applications in the CRM db), so the numbers
// must agree bit for bit: if you change a rule here, change the ERP (and its FE mirror
// utils/hrEmployee.js) in the same breath — and vice versa.
//
// Company policy (owner, 2026-09-01): every employee earns LEAVE_ACCRUAL_PER_MONTH (2.5) days of
// paid leave a month once they have completed ONE MONTH of service. HR keys each person's OPENING
// balance as it stood at the close of a month (`openingAsOf`, 'YYYY-MM'); from the NEXT month on
// the credit lands automatically on the 1st, and every paid-leave day recorded against the person
// (hr_attendance_overrides, state 'leave') is drawn down. Nothing is credited before the policy
// start (LEAVE_ACCRUAL_FROM, 2026-08), before the person is eligible, or after the month they leave.

export const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
export const MONTH_RE = /^\d{4}-\d{2}$/;

export const LEAVE_ACCRUAL_PER_MONTH = 2.5;
// MUST carry the same value as the ERP's HR_LEAVE_ACCRUAL_FROM (both default '2026-08') or the
// two backends will report different balances for the same person.
export const LEAVE_ACCRUAL_FROM = MONTH_RE.test(String(process.env.HR_LEAVE_ACCRUAL_FROM || ''))
  ? String(process.env.HR_LEAVE_ACCRUAL_FROM)
  : '2026-08';

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const str = (v: unknown): string => (v == null ? '' : String(v).trim());
const round1 = (n: number): number => Math.round(n * 10) / 10;

function monthIndex(key: string): number {
  const [y, m] = String(key).split('-').map(Number);
  return y * 12 + (m - 1);
}
function monthKeyOf(index: number): string {
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`;
}
/** Pure: shift a 'YYYY-MM' (or the month of a 'YYYY-MM-DD') by n months. */
export function addMonths(key: string, n: number): string {
  return monthKeyOf(monthIndex(String(key).slice(0, 7)) + n);
}
const laterMonth = (...keys: string[]): string => keys.filter(Boolean).sort().pop() || '';

/** Pure: the first month credited, given the date of joining — the month whose 1st is on or
 *  after DOJ + one month. '' when there is no DOJ (long-serving → the policy start applies). */
export function leaveEligibleFrom(dateOfJoining?: string): string {
  const doj = DAY_RE.test(str(dateOfJoining)) ? str(dateOfJoining) : '';
  if (!doj) return '';
  const oneMonthOn = addMonths(doj, 1);
  return Number(doj.slice(8, 10)) === 1 ? oneMonthOn : addMonths(oneMonthOn, 1);
}

/** A drawdown entry: a paid-leave day and how much of the balance it takes (0.5 for a worked
 *  half-day). Plain day-key strings are accepted everywhere at weight 1. */
export interface LeaveDayEntry { day: string; weight: number }

export interface LeaveBalance {
  asOf: string;
  asOfMonth: string;
  openingBalance: number;
  openingAsOf: string;
  monthlyAccrual: number;
  policyStart: string;
  eligibleFrom: string;
  accrualFrom: string;
  creditedMonths: number;
  accrued: number;
  taken: number;
  takenDays: string[];
  balance: number;
  nextCreditOn: string;
}

/** Pure: the paid-leave balance as at the end of the as-of month. `leaveDays` = the person's
 *  recorded paid-leave day keys (the caller reads them from hr_attendance_overrides, minus
 *  days actually punched — see leave.service). */
export function leaveBalance({
  openingBalance = 0,
  openingAsOf = '',
  monthlyAccrual,
  dateOfJoining = '',
  dateOfLeaving = '',
  asOf,
  leaveDays = [],
}: {
  openingBalance?: unknown;
  openingAsOf?: string;
  monthlyAccrual?: unknown;
  dateOfJoining?: string;
  dateOfLeaving?: string;
  asOf?: string;
  leaveDays?: (string | LeaveDayEntry)[];
} = {}): LeaveBalance {
  const asOfKey = DAY_RE.test(str(asOf)) ? str(asOf) : MONTH_RE.test(str(asOf)) ? `${str(asOf)}-01` : new Date().toISOString().slice(0, 10);
  const asOfMonth = asOfKey.slice(0, 7);
  const opening = num(openingBalance);
  const openingMonth = MONTH_RE.test(str(openingAsOf)) ? str(openingAsOf) : '';
  const perMonth = monthlyAccrual == null || monthlyAccrual === '' ? LEAVE_ACCRUAL_PER_MONTH : Math.max(0, num(monthlyAccrual));
  const dol = DAY_RE.test(str(dateOfLeaving)) ? str(dateOfLeaving) : '';
  const eligibleFrom = leaveEligibleFrom(dateOfJoining);
  const accrualFrom = laterMonth(LEAVE_ACCRUAL_FROM, openingMonth ? addMonths(openingMonth, 1) : '', eligibleFrom);
  const lastMonth = dol && dol.slice(0, 7) < asOfMonth ? dol.slice(0, 7) : asOfMonth;
  const creditedMonths = Math.max(0, monthIndex(lastMonth) - monthIndex(accrualFrom) + 1);
  const accrued = round1(creditedMonths * perMonth);
  // Entries may be plain day keys (weight 1 — the shape before half-day leave) or
  // { day, weight } (a worked half-day draws 0.5). One entry per day, first wins.
  const seen = new Set<string>();
  const takenEntries = (Array.isArray(leaveDays) ? leaveDays : [])
    .map((e) => (typeof e === 'string' ? { day: str(e), weight: 1 } : { day: str(e?.day), weight: e?.weight != null ? Math.max(0, num(e.weight)) : 1 }))
    .filter((e) => DAY_RE.test(e.day) && !seen.has(e.day) && (seen.add(e.day), true))
    .filter((e) => (!openingMonth || e.day.slice(0, 7) > openingMonth) && e.day.slice(0, 7) <= asOfMonth)
    .sort((a, b) => a.day.localeCompare(b.day));
  const takenDays = takenEntries.map((e) => e.day);
  const taken = round1(takenEntries.reduce((s, e) => s + e.weight, 0));
  const nextMonth = laterMonth(addMonths(asOfMonth, 1), accrualFrom);
  const nextCreditOn = dol && nextMonth > dol.slice(0, 7) ? '' : `${nextMonth}-01`;
  return {
    asOf: asOfKey,
    asOfMonth,
    openingBalance: opening,
    openingAsOf: openingMonth,
    monthlyAccrual: perMonth,
    policyStart: LEAVE_ACCRUAL_FROM,
    eligibleFrom,
    accrualFrom,
    creditedMonths,
    accrued,
    taken,
    takenDays,
    balance: round1(opening + accrued - taken),
    nextCreditOn,
  };
}

// ── leave applications (the ask) — bounds identical to the ERP's leaveApplication.service.js ──

/** How far the ask may reach: a little back (sick leave applied after the fact), a year ahead,
 *  and never a span longer than a month — HR corrects anything stranger on the report itself. */
export const MAX_SPAN_DAYS = 31;
export const MAX_BACK_DAYS = 62;
export const MAX_AHEAD_DAYS = 370;

/** Pure: shift a 'YYYY-MM-DD' key by n days (UTC arithmetic on the key alone). */
export function shiftDay(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Pure: every day key in [from..to] inclusive (guarded — [] when malformed/reversed). */
export function spanDays(from: string, to: string): string[] {
  if (!DAY_RE.test(from) || !DAY_RE.test(to) || from > to) return [];
  const out: string[] = [];
  for (let d = from; d <= to && out.length <= MAX_SPAN_DAYS + 1; d = shiftDay(d, 1)) out.push(d);
  return out;
}

/** Pure: do two [from..to] spans share a day? (ISO keys — string compare is date compare.) */
export const spansOverlap = (a: { from: string; to: string }, b: { from: string; to: string }): boolean =>
  a.from <= b.to && b.from <= a.to;

/** The kinds of ask — 'half' is ONE day of which the other half is worked (draws 0.5 when the
 *  half is worked, 1 when the whole day ends up taken). Mirrors the ERP's DAY_TYPES. */
export const DAY_TYPES = ['full', 'half'] as const;
export type LeaveDayType = (typeof DAY_TYPES)[number];

/** Pure: validate and normalise an application body. Throws 400 with the reason said. */
export function validateApplication(
  body: { from?: string; to?: string; reason?: string; dayType?: string } | null | undefined,
  { today }: { today?: string } = {},
): { from: string; to: string; reason: string; days: string[]; dayType: LeaveDayType } {
  const b = body || {};
  const from = String(b.from || '').trim();
  const to = String(b.to || '').trim();
  const reason = String(b.reason || '').trim().slice(0, 500);
  const dayType: LeaveDayType = String(b.dayType || '').trim().toLowerCase() === 'half' ? 'half' : 'full';
  if (!DAY_RE.test(from)) throw BadRequest('From must be a date (YYYY-MM-DD)');
  if (!DAY_RE.test(to)) throw BadRequest('To must be a date (YYYY-MM-DD)');
  if (to < from) throw BadRequest('To cannot be before From');
  if (dayType === 'half' && from !== to) throw BadRequest('A half-day is one day — pick the same From and To');
  if (!reason) throw BadRequest('Say why — the reason goes to HR with the application');
  const days = spanDays(from, to);
  if (days.length > MAX_SPAN_DAYS) throw BadRequest(`One application covers at most ${MAX_SPAN_DAYS} days — split a longer leave`);
  if (today) {
    if (from < shiftDay(today, -MAX_BACK_DAYS)) throw BadRequest('That is too far back — ask HR to record it on the attendance report');
    if (to > shiftDay(today, MAX_AHEAD_DAYS)) throw BadRequest('That is more than a year ahead — apply nearer the time');
  }
  return { from, to, reason, days, dayType };
}
