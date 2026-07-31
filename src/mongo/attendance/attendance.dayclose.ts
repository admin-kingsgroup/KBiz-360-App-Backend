import { attendanceService } from './attendance.service';

// Daily attendance DAY-CLOSE sweep. Every minute it checks the business-timezone hour; once it is
// at/after the configured hour (default 22 = 10pm) it triggers the branch-wise day-close report.
// The report is idempotent per (channel, day), so calling it repeatedly through the evening posts
// exactly once per branch — no in-memory "already ran" flag needed, and a restart between 10pm and
// midnight can't double-post. Same lifecycle shape as reminder.sweep: started from mongo/main.
const ATTENDANCE_TZ = process.env.ATTENDANCE_TZ || 'Asia/Kolkata';
const DAY_CLOSE_HOUR = Number(process.env.ATTENDANCE_DAYCLOSE_HOUR ?? 22); // 24h business-tz hour

let timer: ReturnType<typeof setInterval> | null = null;

// Current hour (0-23) in the business timezone.
function businessHour(): number {
  try {
    return parseInt(new Intl.DateTimeFormat('en-GB', { timeZone: ATTENDANCE_TZ, hour: '2-digit', hour12: false }).format(new Date()), 10);
  } catch {
    return new Date().getUTCHours();
  }
}

export function startAttendanceDayClose(intervalMs = 60_000): void {
  if (timer) return;
  timer = setInterval(() => {
    if (businessHour() < DAY_CLOSE_HOUR) return; // only from 10pm local onward
    // Auto-close forgotten check-outs FIRST (stamped 7pm, method 'Auto-closed'), then the report —
    // so the day-close summary counts those days as closed rather than "still in".
    void attendanceService.autoCloseOpenDays()
      .then((r) => {
        // eslint-disable-next-line no-console
        if (r.closed > 0) console.log(`[attendance-dayclose] auto-closed ${r.closed} forgotten checkout(s) for ${r.day}`);
        return attendanceService.dayCloseReport();
      })
      .catch((e: Error) => {
        // eslint-disable-next-line no-console
        console.warn('[attendance-dayclose] error:', e.message);
      });
  }, intervalMs);
}

export function stopAttendanceDayClose(): void {
  if (timer) { clearInterval(timer); timer = null; }
}
