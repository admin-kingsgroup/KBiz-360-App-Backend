import { attendanceService } from './attendance.service';

// Daily attendance DAY-CLOSE sweep. Every minute it checks the business-timezone hour; inside the
// 22:00–03:59 IST window it runs the forgotten-checkout auto-close (which gates itself at 10pm in
// each BRANCH's local timezone), and from 22:00 IST it also triggers the branch-wise day-close
// report. The report is idempotent per (channel, day), so calling it repeatedly through the
// evening posts exactly once per branch — no in-memory "already ran" flag needed, and a restart
// between 10pm and midnight can't double-post. Same lifecycle shape as reminder.sweep: started
// from mongo/main.
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
    // Auto-close fires at 10pm in each BRANCH's local night (owner call, 08-07), so the tick
    // window must span every branch's local 10pm: 22:00 IST (India) through 03:59 IST (FBM's
    // 10pm = 01:30 IST). autoCloseOpenDays self-gates per branch inside that window and stamps
    // the checkout at the branch's LOCAL office-end time (7pm IST India, 5:30pm DAR/FBM,
    // 6:30pm NBO), method 'Auto-closed'.
    const hour = businessHour();
    if (hour < DAY_CLOSE_HOUR && hour >= 4) return;
    void attendanceService.autoCloseOpenDays()
      .then((r) => {
        // eslint-disable-next-line no-console
        if (r.closed > 0) console.log(`[attendance-dayclose] auto-closed ${r.closed} forgotten checkout(s) for ${r.day}`);
        // The REPORT stays on the IST clock (posts once from 10pm IST): past IST midnight
        // todayKey() is a fresh day, and reporting on it would post an all-absent summary at
        // half past midnight.
        return hour >= DAY_CLOSE_HOUR ? attendanceService.dayCloseReport() : undefined;
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
