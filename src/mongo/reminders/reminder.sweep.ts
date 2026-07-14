import { remindersService } from './reminder.service';

// Due-time sweep: every minute, push "⏰ Reminder due" to assignees of pending reminders whose
// dueAt has passed (each fires once — dueNotifiedAt marks it sent). Same lifecycle shape as
// email.poll: started from mongo/main, safe to call twice, cleared on shutdown.
let timer: ReturnType<typeof setInterval> | null = null;

export function startReminderDueSweep(intervalMs = 60_000): void {
  if (timer) return;
  timer = setInterval(() => {
    void remindersService.sweepDue().catch((e: Error) => {
      // eslint-disable-next-line no-console
      console.warn('[reminder-sweep] error:', e.message);
    });
  }, intervalMs);
}

export function stopReminderDueSweep(): void {
  if (timer) { clearInterval(timer); timer = null; }
}
