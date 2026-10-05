import { attendanceService } from './attendance.service';
import { fcm } from '../../push/fcm';
import { fcmDeviceRepo } from '../../push/fcm.devices';

// Morning ARRIVAL WAKE for automatic attendance. Once a minute this asks the service who should be
// woken (people with an office, inside their branch's local arrival window, not yet checked in —
// see attendanceService.arrivalWakeTargets) and sends each of their phones a SILENT push at most
// every ARRIVAL_WAKE_EVERY_MIN minutes. The app's background handler ('attendance_check') re-arms
// the office boundary watch, takes a fix and checks the person in if they are at the office.
// Nothing is shown on the phone. A person stops being woken the moment they are checked in, and
// everyone stops at the end of the window, so the cost is a handful of pushes per person per day.
//
// Off when: ATTENDANCE_ARRIVAL_WAKE=off, automatic attendance itself is off, or Firebase is not
// configured (fcm.isConfigured) — then the phone's own ~15-minute check remains the safety net.
const ENABLED = process.env.ATTENDANCE_ARRIVAL_WAKE !== 'off';
export const ARRIVAL_WAKE_EVERY_MIN = Math.max(2, Number(process.env.ATTENDANCE_ARRIVAL_WAKE_MIN ?? 4) || 4);

// Pure: is this user due for another wake?
export function wakeDue(lastSentAt: number | undefined, now: number, everyMin: number = ARRIVAL_WAKE_EVERY_MIN): boolean {
  return lastSentAt === undefined || now - lastSentAt >= everyMin * 60_000 - 5_000; // 5 s slack for timer jitter
}

const lastSent = new Map<string, number>();
let timer: ReturnType<typeof setInterval> | null = null;
let running = false;

export async function arrivalWakeTick(now: Date = new Date()): Promise<number> {
  if (!ENABLED || !fcm.isConfigured() || running) return 0;
  running = true;
  let sent = 0;
  try {
    const targets = await attendanceService.arrivalWakeTargets(now);
    const live = new Set(targets);
    for (const id of [...lastSent.keys()]) if (!live.has(id)) lastSent.delete(id); // checked in / window over
    for (const userId of targets) {
      if (!wakeDue(lastSent.get(userId), now.getTime())) continue;
      lastSent.set(userId, now.getTime());
      const tokens = await fcmDeviceRepo.tokensForUser(userId);
      for (const token of tokens) if (await fcm.sendSilent(token, { type: 'attendance_check' })) sent++;
    }
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[attendance-arrival] error:', (e as Error).message);
  } finally {
    running = false;
  }
  return sent;
}

export function startAttendanceArrivalWake(intervalMs = 60_000): void {
  if (timer || !ENABLED) return;
  timer = setInterval(() => { void arrivalWakeTick(); }, intervalMs);
}

export function stopAttendanceArrivalWake(): void {
  if (timer) { clearInterval(timer); timer = null; }
  lastSent.clear();
}
