import { config } from '../config';
import { emailAccountRepo, type EmailAccountDoc } from './account.model';
import { graph } from './graph';
import { emailPush } from './email.push';
import { smartFolderRepo } from './smartFolder.model';

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

    // Smart-folder routing: move each new message whose sender matches a rule into that folder. We do
    // this BEFORE notifying so a routed mail still triggers its new-mail push (it's still "new mail").
    // (The primary filing path is the native Outlook inbox rule created with the folder — this poll
    // routing is the fallback for rule-creation failures and pre-rule folders.)
    const rules = await smartFolderRepo.listForUser(acct.userId);
    // One-time upgrade for folders created BEFORE native rules existed: give them one now, so their
    // filing becomes instant and mailbox-native instead of poll-delayed.
    for (const r of rules) {
      if (r.graphRuleId || !r.from.length) continue;
      try {
        const rule = await graph.createInboxRule(acct.userId, `KB360 · ${r.name}`, r.from, r.graphFolderId);
        await smartFolderRepo.setRuleId(acct.userId, r._id, rule.id);
      } catch { /* retry next poll */ }
    }
    if (rules.length) {
      for (const m of msgs) {
        const fromEmail = (m.fromEmail || '').toLowerCase();
        if (!fromEmail) continue;
        const target = rules.find((r) => r.from.some((x) => x && fromEmail.includes(x.toLowerCase())));
        if (target) await graph.moveToFolderId(acct.userId, m.id, target.graphFolderId).catch(() => undefined);
      }
    }

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
// 60s: near-real-time new-mail push + smart-folder routing without a public webhook. (A Graph
// change-notification subscription would be instant, but needs renewal/validation plumbing — a
// future upgrade now that the backend is hosted over HTTPS.)
export function startEmailPolling(intervalMs = 60_000): void {
  if (timer || !config.msEmail.clientId) return;
  timer = setInterval(() => { void pollOnce(); }, intervalMs);
  // eslint-disable-next-line no-console
  console.log(`[email] new-mail polling every ${Math.round(intervalMs / 1000)}s`);
}
