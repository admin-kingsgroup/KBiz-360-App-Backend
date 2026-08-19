import { attendanceService } from './attendance.service';

// Daily attendance DAY-CLOSE sweep. Every minute it checks the business-timezone hour; inside the
// 22:00–03:59 IST window it runs the forgotten-checkout auto-close AND the branch-wise day-close
// report — both of which gate themselves at 10pm in each BRANCH's local timezone, which is what
// that odd-looking window spans (India's 10pm is 22:00 IST, FBM's is 01:30 IST the next day).
// The report is idempotent per (branch, day), so calling it repeatedly through the evening posts
// exactly once per branch — no in-memory "already ran" flag needed, and a restart between 10pm
// and midnight can't double-post. Same lifecycle shape as reminder.sweep: started from mongo/main.
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
        // The report runs on EVERY tick in the window, not just from 22:00 IST: an African
        // branch's 10pm falls in the IST small hours (NBO 00:30, FBM 01:30), and gating on the
        // IST hour is exactly what would skip it. Each branch decides for itself inside, on its
        // own clock and its own calendar day.
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
