import { appDb } from '../connection';
import { getStorage } from '../../storage';

// Attachment reaper: alert events expire via the 90-day TTL index, but Mongo only removes the
// DOCUMENT — the stored PDF (local uploads dir or S3) would leak forever. Every 6 hours this
// deletes the stored file for events expiring within the next 24h (i.e. before the TTL monitor
// takes the doc and its key with it) and $unsets the attachment so no dead link lingers.
// Same lifecycle shape as reminder.sweep: started from mongo/main, safe to call twice.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const col = () => appDb().collection('alert_events') as any;
let timer: ReturnType<typeof setInterval> | null = null;

export async function sweepExpiredAttachments(): Promise<number> {
  const cutoff = new Date(Date.now() + 24 * 3600 * 1000);
  const docs = await col()
    .find({ 'attachment.key': { $exists: true, $ne: null }, expiresAt: { $lte: cutoff } })
    .project({ attachment: 1 })
    .toArray();
  let cleaned = 0;
  for (const d of docs) {
    try {
      await getStorage().delete(String(d.attachment.key));
      await col().updateOne({ _id: d._id }, { $unset: { attachment: '' } });
      cleaned += 1;
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[alert-sweep] could not reap attachment:', (e as Error).message);
    }
  }
  // eslint-disable-next-line no-console
  if (cleaned) console.log(`[alert-sweep] reaped ${cleaned} expiring attachment(s)`);
  return cleaned;
}

export function startAlertAttachmentSweep(intervalMs = 6 * 3600 * 1000): void {
  if (timer) return;
  timer = setInterval(() => {
    void sweepExpiredAttachments().catch((e: Error) => {
      // eslint-disable-next-line no-console
      console.warn('[alert-sweep] error:', e.message);
    });
  }, intervalMs);
  // One pass shortly after boot so a long-stopped server catches up quickly.
  setTimeout(() => { void sweepExpiredAttachments().catch(() => undefined); }, 30_000).unref?.();
}

export function stopAlertAttachmentSweep(): void {
  if (timer) { clearInterval(timer); timer = null; }
}
