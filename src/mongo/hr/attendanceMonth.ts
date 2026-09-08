// Month muster-roll classification — a FAITHFUL PORT of the ERP's
// src/features/hr/employeeAttendance.service.js (classifyDay/buildMonth/summarizeMonth) plus the
// attendance report's evidence rule (a blank day is an absence only when the login could have
// punched). The ERP central report and this self-service month must read every day identically —
// change the ERP and this port in the same breath.

const ATTENDANCE_TZ = process.env.ATTENDANCE_TZ || 'Asia/Kolkata';

// The weekly off, as UTC weekday numbers of the day KEY (0 = Sunday) — group default.
export const WEEK_OFF_DAYS: number[] = String(process.env.ATTENDANCE_WEEK_OFF || '0')
  .split(',').map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n >= 0 && n <= 6);

const HOURS_ROUND = (ms: number): number => Math.round((ms / 3600000) * 100) / 100;

export const MONTH_KEY_RE = /^\d{4}-\d{2}$/;
export const isMonthKey = (s: string): boolean => MONTH_KEY_RE.test(String(s || ''));
export const monthOf = (dayKey: string): string => String(dayKey || '').slice(0, 7);

/** Pure: every day key in a month, in order ([] for a malformed month). */
export function monthDayKeys(month: string): string[] {
  if (!isMonthKey(month)) return [];
  const [y, m] = month.split('-').map(Number);
  const out: string[] = [];
  const d = new Date(Date.UTC(y, m - 1, 1));
  while (d.getUTCMonth() === m - 1) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

/** Pure: UTC weekday (0 = Sun) of a day key. */
export const weekdayNo = (dayKey: string): number => new Date(`${dayKey}T00:00:00Z`).getUTCDay();
export const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export interface WeekOffPolicy { days?: number[]; saturdays?: string }
const DEFAULT_WEEK_OFF: WeekOffPolicy = { days: WEEK_OFF_DAYS, saturdays: 'none' };
const saturdayOrdinal = (dayKey: string): number => Math.ceil(Number(dayKey.slice(8, 10)) / 7);

/** Pure: is the day a weekly off under the person's policy? */
export function isWeekOffDay(dayKey: string, policy?: WeekOffPolicy | null): boolean {
  const p = policy && typeof policy === 'object' ? policy : DEFAULT_WEEK_OFF;
  const wd = weekdayNo(dayKey);
  if ((Array.isArray(p.days) ? p.days : WEEK_OFF_DAYS).map(Number).includes(wd)) return true;
  if (wd !== 6) return false;
  const rule = String(p.saturdays || 'none');
  if (rule === 'all') return true;
  if (rule === 'odd') return saturdayOrdinal(dayKey) % 2 === 1;
  if (rule === 'even') return saturdayOrdinal(dayKey) % 2 === 0;
  return false;
}

/** Pure: the zone's offset from UTC (ms) at an instant, via Intl — no tz library. */
function tzOffsetMs(ms: number, tz: string = ATTENDANCE_TZ): number {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(ms));
    const g = (t: string): number => Number((parts.find((x) => x.type === t) || {}).value);
    const local = Date.UTC(g('year'), g('month') - 1, g('day'), g('hour') % 24, g('minute'), g('second'));
    return local - Math.floor(ms / 1000) * 1000;
  } catch { return 0; }
}

/** Pure: the UTC instant of 'HH:MM' wall-clock on a day in the business timezone. */
export function instantAt(dayKey: string, hhmm: string, tz: string = ATTENDANCE_TZ): Date | null {
  const m = /^(\d{2}):(\d{2})$/.exec(String(hhmm || '').trim());
  if (!m || !/^\d{4}-\d{2}-\d{2}$/.test(String(dayKey || ''))) return null;
  const hh = Number(m[1]); const mi = Number(m[2]);
  if (hh > 23 || mi > 59) return null;
  const [y, mo, d] = dayKey.split('-').map(Number);
  const guess = Date.UTC(y, mo - 1, d, hh, mi);
  let utc = guess - tzOffsetMs(guess, tz);
  const again = guess - tzOffsetMs(utc, tz);
  if (again !== utc) utc = again;
  return new Date(utc);
}

function hoursBetween(inAt: Date | string | null | undefined, outAt: Date | string | null | undefined): number | null {
  if (!inAt || !outAt) return null;
  const a = new Date(inAt).getTime(); const b = new Date(outAt).getTime();
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return null;
  return HOURS_ROUND(b - a);
}

export interface ShiftPolicy { start?: string; end?: string; graceMinutes?: number }

function latenessOf(dayKey: string, checkInAt: Date | string | null, shift?: ShiftPolicy | null, tz: string = ATTENDANCE_TZ): { minutes: number; grace: number; late: boolean } | null {
  if (!shift || !checkInAt) return null;
  const startAt = instantAt(dayKey, shift.start ?? '', tz);
  if (!startAt) return null;
  const inMs = new Date(checkInAt).getTime();
  if (!Number.isFinite(inMs)) return null;
  const minutes = Math.max(0, Math.round((inMs - startAt.getTime()) / 60000));
  const grace = Math.max(0, Math.round(Number(shift.graceMinutes) || 0));
  return { minutes, grace, late: minutes > grace };
}

export interface Employment { dateOfJoining?: string; dateOfLeaving?: string }
export function employedOn(dayKey: string, { dateOfJoining = '', dateOfLeaving = '' }: Employment = {}): boolean {
  if (dateOfJoining && dayKey < dateOfJoining) return false;
  if (dateOfLeaving && dayKey > dateOfLeaving) return false;
  return true;
}

export interface HolidayInfo { name?: string; kind?: 'closed' | 'optional'; movable?: boolean }
export interface DayRecord {
  checkInAt?: Date | null; checkOutAt?: Date | null; method?: string | null; present?: boolean;
  checkInPhotoUrl?: string | null; checkOutPhotoUrl?: string | null;
  faceVerified?: boolean | null; distanceMeters?: number | null; adjustedBy?: string | null;
}
export interface DayOverride { state?: string }

export type DayState = 'present' | 'absent' | 'holiday' | 'weekOff' | 'leave' | 'future' | 'notEmployed' | 'noData';

export interface ClassifiedDay {
  day: string;
  weekday: string;
  state: DayState;
  checkInAt: Date | string | null;
  checkOutAt: Date | string | null;
  method: string;
  hours: number | null;
  holiday: { name: string; kind: string } | null;
  weekOff: boolean;
  granted: boolean;
  onLeave: boolean;
  halfLeave: boolean; // half-day paid leave — rides a present day (the other half is worked)
  open: boolean;
  autoClosed: boolean;
  adjusted: boolean;
  markedAbsent: boolean;
  late: boolean;
  lateMinutes: number | null;
}

/** Pure: classify ONE calendar day — the ERP's precedence, verbatim. */
export function classifyDay(dayKey: string, { record, holiday, today, employment, policy, override, shift, tz = ATTENDANCE_TZ }: {
  record?: DayRecord | null; holiday?: HolidayInfo | null; today?: string; employment?: Employment;
  policy?: WeekOffPolicy | null; override?: DayOverride | null; shift?: ShiftPolicy | null; tz?: string;
} = {}): ClassifiedDay {
  const weekOffToday = isWeekOffDay(dayKey, policy ?? undefined);
  const grantedOff = !!override && override.state === 'weekOff';
  const grantedHoliday = !!override && override.state === 'optionalHoliday';
  const grantedLeave = !!override && override.state === 'leave';
  const grantedHalf = !!override && override.state === 'halfLeave';
  const base: Omit<ClassifiedDay, 'state'> = {
    day: dayKey,
    weekday: WEEKDAY_SHORT[weekdayNo(dayKey)],
    checkInAt: record?.checkInAt ?? null,
    checkOutAt: record?.checkOutAt ?? null,
    method: record?.method || '',
    hours: hoursBetween(record?.checkInAt, record?.checkOutAt),
    holiday: holiday
      ? { name: holiday.name || '', kind: holiday.kind || 'closed' }
      : (grantedHoliday ? { name: '', kind: 'optional' } : null),
    weekOff: weekOffToday || grantedOff,
    granted: grantedOff || grantedHoliday || grantedLeave || grantedHalf,
    onLeave: grantedLeave,
    halfLeave: grantedHalf,
    open: false, autoClosed: false, adjusted: false, markedAbsent: false,
    late: false, lateMinutes: null,
  };
  const closedHoliday = !!holiday && (holiday.kind || 'closed') === 'closed';
  const punched = !!(record && record.checkInAt);

  if (!employedOn(dayKey, employment)) return { ...base, state: 'notEmployed' };
  if (punched && record) {
    const lateness = closedHoliday || base.weekOff ? null : latenessOf(dayKey, record.checkInAt ?? null, shift, tz);
    return {
      ...base,
      state: 'present',
      open: !record.checkOutAt,
      autoClosed: /^auto-closed$/i.test(String(record.method || '')),
      adjusted: !!record.adjustedBy,
      late: !!(lateness && lateness.late),
      lateMinutes: lateness ? lateness.minutes : null,
    };
  }
  if (record && String(record.method || '') === 'Manual' && record.present === false) {
    return { ...base, state: 'absent', markedAbsent: true, adjusted: true };
  }
  if (grantedOff) return { ...base, state: 'weekOff' };
  if (grantedHoliday) return { ...base, state: 'holiday' };
  if (grantedLeave) return { ...base, state: 'leave' };
  // A half-day leave whose worked half never got a punch — the whole day ended up taken (paid).
  if (grantedHalf) return { ...base, state: 'leave' };
  if (today && dayKey > today) return { ...base, state: 'future' };
  if (closedHoliday) return { ...base, state: 'holiday' };
  if (base.weekOff) return { ...base, state: 'weekOff' };
  return { ...base, state: 'absent' };
}

/** Pure: the whole month, one entry per calendar day. */
export function buildMonth(month: string, { recordsByDay = new Map<string, DayRecord>(), holidayByDay = new Map<string, HolidayInfo>(), overridesByDay = new Map<string, DayOverride>(), today, employment, policy, shift, tz }: {
  recordsByDay?: Map<string, DayRecord>; holidayByDay?: Map<string, HolidayInfo>; overridesByDay?: Map<string, DayOverride>;
  today?: string; employment?: Employment; policy?: WeekOffPolicy | null; shift?: ShiftPolicy | null; tz?: string;
} = {}): ClassifiedDay[] {
  return monthDayKeys(month).map((day) => classifyDay(day, {
    record: recordsByDay.get(day), holiday: holidayByDay.get(day), override: overridesByDay.get(day), today, employment, policy, shift, tz,
  }));
}

// The attendance report's evidence rule: a blank working day counts as an ABSENCE only when the
// login could actually have punched — a month (or day) before the person's first-ever punch, or a
// login that never punched, is "no data", never absent, never loss-of-pay.
export function applyNoData(days: ClassifiedDay[], { firstPunchDay = '' }: { firstPunchDay?: string } = {}): ClassifiedDay[] {
  return days.map((d) => (
    d.state === 'absent' && !d.markedAbsent && (!firstPunchDay || d.day < firstPunchDay)
      ? { ...d, state: 'noData' as const }
      : d
  ));
}

export interface MonthSummary {
  calendarDays: number; workingDays: number; present: number; absent: number; leave: number;
  holidays: number; weekOffs: number; future: number; notEmployed: number; noData: number; halfLeaves: number;
  hoursTotal: number; avgHours: number; autoClosed: number; adjusted: number; stillOpen: number;
  lateMarks: number; workedOnHoliday: number; workedOnWeekOff: number; granted: number;
}

/** Pure: muster-roll totals for the month (the ERP's summarizeMonth + a noData count). */
export function summarizeMonth(days: ClassifiedDay[]): MonthSummary {
  const by = (s: DayState): ClassifiedDay[] => days.filter((d) => d.state === s);
  const present = by('present');
  const absent = by('absent');
  const leave = by('leave');
  const closed = present.filter((d) => d.hours != null);
  const hoursTotal = Math.round(closed.reduce((s, d) => s + (d.hours as number), 0) * 100) / 100;
  return {
    calendarDays: days.length,
    workingDays: present.length + absent.length + leave.length,
    present: present.length,
    absent: absent.length,
    leave: leave.length,
    holidays: by('holiday').length,
    weekOffs: by('weekOff').length,
    future: by('future').length,
    notEmployed: by('notEmployed').length,
    noData: by('noData').length,
    hoursTotal,
    avgHours: closed.length ? Math.round((hoursTotal / closed.length) * 100) / 100 : 0,
    autoClosed: present.filter((d) => d.autoClosed).length,
    adjusted: days.filter((d) => d.adjusted).length,
    stillOpen: present.filter((d) => d.open).length,
    lateMarks: present.filter((d) => d.late).length,
    workedOnHoliday: present.filter((d) => d.holiday && d.holiday.kind === 'closed').length,
    workedOnWeekOff: present.filter((d) => d.weekOff && !d.holiday).length,
    granted: days.filter((d) => d.granted).length,
    halfLeaves: days.filter((d) => d.halfLeave).length,
  };
}
