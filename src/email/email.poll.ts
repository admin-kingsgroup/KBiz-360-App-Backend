import { config } from '../config';
import { emailAccountRepo, type EmailAccountDoc } from './account.model';
import { graph } from './graph';
import { emailPush } from './email.push';

// New-mail notifications via polling (no public webhook URL needed — works on a localhost/LAN
// backend). For each connected mailbox, look for inbox messages received since the last poll and
// push them. A Graph change-notification subscription is a future upgrade once the backend is
// publicly hosted over HTTPS.
async function pollUser(acct: EmailAccountDoc): Promise<void> {
  // First poll just sets a baseline so we don't blast a notification for every existing message.
  if (!acct.lastPolledAt) {
    await emailAccountRepo.update(acct.userId, { lastPolledAt: new Date() });
    return;
  }
  try {
    const msgs = await graph.newSince(acct.userId, new Date(acct.lastPolledAt).toISOString());
    if (msgs.length === 1) await emailPush.notifyNewMail(acct.userId, msgs[0].from, msgs[0].subject);
    else if (msgs.length > 1) await emailPush.notifyNewMail(acct.userId, `${msgs.length} new emails`, `Latest: ${msgs[0].subject}`);
    await emailAccountRepo.update(acct.userId, { lastPolledAt: new Date() });
  } catch {
    // token revoked / disconnected / Graph error — skip this round, try again next interval.
  }
}

export async function pollOnce(): Promise<void> {
  if (!config.msEmail.clientId) return; // email not configured
  const accounts = await emailAccountRepo.all();
  for (const a of accounts) await pollUser(a);
}

let timer: ReturnType<typeof setInterval> | null = null;
export function startEmailPolling(intervalMs = 180_000): void {
  if (timer || !config.msEmail.clientId) return;
  timer = setInterval(() => { void pollOnce(); }, intervalMs);
  // eslint-disable-next-line no-console
  console.log(`[email] new-mail polling every ${Math.round(intervalMs / 1000)}s`);
}
