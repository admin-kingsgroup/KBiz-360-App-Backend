import { dayStatesFor, type HrDayState } from './myMonth.service';
import type { DayState } from './attendanceMonth';

// The Attendance history list (GET /attendance/history and the admin per-user view) is built from
// the app's punch rows only, so on its own every day without a punch reads as absent — holidays and
// week offs included. This stamps each entry with the HR state My Attendance shows for that day
// (the ERP muster's classifier: holidays, week-off policy, granted overrides, approved leave).
//
// Lives here, applied at the route, rather than inside attendance.service: myMonth.service already
// reaches attendance.service through hrNotify, so importing it there would close a module cycle.

export type HistoryWithState<T> = T & { state?: DayState; holidayName?: string | null; halfLeave?: boolean };

/** Adds `state` (+ `holidayName`, `halfLeave`) to each { date } entry. Never throws: if the HR read
 *  fails the entries come back unchanged and the app falls back to its punch-only reading. */
export async function withHrDayStates<T extends { date: string }>(
  userId: string,
  entries: T[],
  states: (userId: string, from: string, to: string) => Promise<Map<string, HrDayState>> = dayStatesFor,
): Promise<HistoryWithState<T>[]> {
  if (!entries.length) return entries;
  try {
    const keys = entries.map((e) => e.date).sort();
    const byDay = await states(userId, keys[0], keys[keys.length - 1]);
    return entries.map((e) => {
      const s = byDay.get(e.date);
      return s ? { ...e, state: s.state, holidayName: s.holiday, halfLeave: s.halfLeave } : e;
    });
  } catch {
    return entries;
  }
}
