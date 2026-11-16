import type { RepeatRule } from './task.types';

// Pure time helpers for tasks. A person's time zone is their first branch's: the CRM branch docs carry
// only a code, so the zone is resolved from it (same table attendance uses for the African branches);
// every other branch runs on India time.
const BRANCH_TZ: Record<string, string> = {
  NBO: 'Africa/Nairobi',
  DAR: 'Africa/Dar_es_Salaam',
  FBM: 'Africa/Lubumbashi',
};
export const DEFAULT_TZ = process.env.TASKS_TZ || 'Asia/Kolkata';

export function tzForBranchCode(code?: string | null): string {
  return BRANCH_TZ[String(code ?? '').trim().toUpperCase()] ?? DEFAULT_TZ;
}

export const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;
export const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function fmt(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    // hourCycle 'h23', NOT hour12:false — the latter renders midnight as "24" in Node's ICU.
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', weekday: 'short',
    });
    fmtCache.set(tz, f);
  }
  return f;
}

const WEEKDAY: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export interface LocalParts { dayKey: string; hour: number; minute: number; weekday: number }

// The wall clock of `at` in `tz`.
export function localParts(at: Date, tz: string): LocalParts {
  const p: Record<string, string> = {};
  for (const part of fmt(tz).formatToParts(at)) p[part.type] = part.value;
  return {
    dayKey: `${p.year}-${p.month}-${p.day}`,
    hour: Number(p.hour),
    minute: Number(p.minute),
    weekday: WEEKDAY[p.weekday] ?? 0,
  };
}

// The UTC instant whose wall clock in `tz` reads `dayKey hh:mm`.
export function zonedDateTime(dayKey: string, hhmm: string, tz: string): Date {
  const guess = new Date(`${dayKey}T${hhmm}:00.000Z`);
  const lp = localParts(guess, tz);
  const asIfUtc = Date.UTC(
    Number(lp.dayKey.slice(0, 4)), Number(lp.dayKey.slice(5, 7)) - 1, Number(lp.dayKey.slice(8, 10)), lp.hour, lp.minute,
  );
  const offset = asIfUtc - guess.getTime(); // how far the zone is ahead of UTC
  return new Date(guess.getTime() - offset);
}

export const addDays = (dayKey: string, n: number): string => {
  const d = new Date(`${dayKey}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

// Quiet hours: no push between 22:00 and 07:00 in the recipient's zone (urgent tasks excepted by the caller).
export const QUIET_FROM_HOUR = 22;
export const QUIET_TO_HOUR = 7;
export function inQuietHours(at: Date, tz: string): boolean {
  const { hour } = localParts(at, tz);
  return hour >= QUIET_FROM_HOUR || hour < QUIET_TO_HOUR;
}

// Working hours for the "not accepted after 4 working hours" nudge: Monday–Saturday, 10:00–19:00 local
// (Sunday is the week off). Counted day by day in the zone, clipped to the window.
export const WORK_START = '10:00';
export const WORK_END = '19:00';
export function workingMsBetween(from: Date, to: Date, tz: string): number {
  if (to.getTime() <= from.getTime()) return 0;
  let total = 0;
  let day = localParts(from, tz).dayKey;
  const lastDay = localParts(to, tz).dayKey;
  for (let guard = 0; guard < 400 && day <= lastDay; guard += 1, day = addDays(day, 1)) {
    const weekday = new Date(`${day}T12:00:00.000Z`).getUTCDay();
    if (weekday === 0) continue;
    const start = Math.max(zonedDateTime(day, WORK_START, tz).getTime(), from.getTime());
    const end = Math.min(zonedDateTime(day, WORK_END, tz).getTime(), to.getTime());
    if (end > start) total += end - start;
  }
  return total;
}

const daysInMonth = (year: number, month0: number): number => new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate();

// The next due instant of a repeating task after `prevDue`, at the same local time of day.
export function nextOccurrence(prevDue: Date, rule: RepeatRule, tz: string): Date | null {
  const lp = localParts(prevDue, tz);
  const hhmm = `${String(lp.hour).padStart(2, '0')}:${String(lp.minute).padStart(2, '0')}`;
  if (rule.kind === 'daily') return zonedDateTime(addDays(lp.dayKey, 1), hhmm, tz);
  if (rule.kind === 'weekly') {
    const days = [...new Set(rule.days)].filter((d) => d >= 0 && d <= 6);
    if (!days.length) return null;
    for (let i = 1; i <= 7; i += 1) {
      const dk = addDays(lp.dayKey, i);
      if (days.includes(new Date(`${dk}T12:00:00.000Z`).getUTCDay())) return zonedDateTime(dk, hhmm, tz);
    }
    return null;
  }
  if (rule.kind === 'monthly') {
    const dom = Math.min(31, Math.max(1, Math.floor(rule.dayOfMonth)));
    let year = Number(lp.dayKey.slice(0, 4));
    let month0 = Number(lp.dayKey.slice(5, 7)) - 1;
    const today = Number(lp.dayKey.slice(8, 10));
    // This month if its (clamped) day is still ahead, otherwise next month.
    if (Math.min(dom, daysInMonth(year, month0)) <= today) {
      month0 += 1;
      if (month0 > 11) { month0 = 0; year += 1; }
    }
    const day = Math.min(dom, daysInMonth(year, month0));
    const dk = `${year}-${String(month0 + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    return zonedDateTime(dk, hhmm, tz);
  }
  return null;
}

// "18 Nov, 4:12 pm" in the given zone — the format the spec's system messages use.
export function shortStamp(at: Date, tz: string): string {
  const d = new Intl.DateTimeFormat('en-GB', { timeZone: tz, day: 'numeric', month: 'short' }).format(at);
  const t = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit', hour12: true }).format(at).toLowerCase();
  return `${d}, ${t}`;
}
// "20 Nov 2026" in the given zone.
export function longDate(at: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: tz, day: 'numeric', month: 'short', year: 'numeric' }).format(at);
}
