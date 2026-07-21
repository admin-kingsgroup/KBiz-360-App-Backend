import { config } from '../../config';
import { callDeviceRepo } from '../calls/call.repository';
import { crmRepo } from '../crm.repo';
import { appDb } from '../connection';
import { ALERT_CHANNELS, USER_ALERTS_CHANNEL_ID } from './alertChannels';

// Push notifications for system alerts. The socket 'alert:new' only reaches OPEN apps —
// this is what taps people on the shoulder when the app is closed. Audience per channel
// event = super-admins + the channel's grant holders (exactly who can see it in the feed),
// minus the acting user; announcements go to their recipient list ('*' = everyone).
// Mirrors reminder.push.ts: shared push_devices Expo tokens, dry-run unless
// EXPO_PUSH_ENABLED=true, batches of ≤100, fire-and-forget everywhere.

const isExpoPushToken = (t: string): boolean => /^Expo(nent)?PushToken\[[^\]]+\]$/.test(t);
const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

interface ExpoMessage {
  to: string;
  title: string;
  body: string;
  data: Record<string, unknown>;
  sound: 'default';
  channelId: 'default';
  priority: 'high';
}

async function postToExpo(messages: ExpoMessage[]): Promise<void> {
  for (let i = 0; i < messages.length; i += 100) {
    const chunk = messages.slice(i, i + 100);
    try {
      await fetch(EXPO_PUSH_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          ...(config.push.expoAccessToken ? { Authorization: `Bearer ${config.push.expoAccessToken}` } : {}),
        },
        body: JSON.stringify(chunk),
      });
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[alert-push] send error:', (e as Error).message);
    }
  }
}

// ── Audience resolution, cached 60s ───────────────────────────────────────────
// A bulk booking approval can burst 100+ alert events; without a cache each one
// would re-read roles + users from the throttled shared Atlas tier.
const CACHE_MS = 60_000;
let _cache: { at: number; superIds: string[]; disabled: Set<string> } | null = null;

async function baseAudience(): Promise<{ superIds: string[]; disabled: Set<string> }> {
  if (_cache && Date.now() - _cache.at < CACHE_MS) return _cache;
  const roles = await crmRepo.listRoles();
  const superRoleIds = new Set(
    roles.filter((r) => r.level === 1 || (r.permissions ?? []).includes('*')).map((r) => String(r._id)),
  );
  const users = await crmRepo.listUsers({ status: 'active' });
  const superIds = users
    .filter((u) => superRoleIds.has(String(u.role_id)) && u.access?.app !== false)
    .map((u) => String(u._id));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const disabledDocs = await (appDb().collection('app_access') as any).find({ disabled: true }).toArray();
  const disabled = new Set<string>(disabledDocs.map((d: { userId?: string }) => String(d.userId)));
  _cache = { at: Date.now(), superIds, disabled };
  return _cache;
}

async function grantHolders(grant: string): Promise<string[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const docs = await (appDb().collection('alert_grants') as any).find({ alerts: grant }).toArray();
  return docs.map((d: { userId?: string }) => String(d.userId));
}

async function sendToUsers(userIds: string[], title: string, text: string, channelId: string): Promise<void> {
  const unique = [...new Set(userIds)];
  if (!unique.length) return;
  const body = text.length > 110 ? `${text.slice(0, 107)}…` : text;
  const tokenLists = await Promise.all(unique.map((id) => callDeviceRepo.tokensForUser(id).catch(() => [] as string[])));
  const messages: ExpoMessage[] = tokenLists.flat().filter(isExpoPushToken).map((to) => ({
    to,
    title,
    body,
    data: { type: 'alert', id: channelId }, // routes to /alert/[channelId] (services/notifications/routes.ts)
    sound: 'default',
    channelId: 'default',
    priority: 'high',
  }));
  if (!messages.length) return;
  if (!config.push.enabled) {
    // eslint-disable-next-line no-console
    console.log(`[alert-push] dry-run "${title}" to ${messages.length} device(s) / ${unique.length} user(s)`);
    return;
  }
  await postToExpo(messages);
}

export const alertPush = {
  // Channel event → everyone who can see the channel (supers + grant holders), minus the actor.
  async sendChannelAlert(channelId: string, title: string, body: string, actorUserId?: string | null): Promise<void> {
    try {
      const channel = ALERT_CHANNELS.find((c) => c.id === channelId);
      if (!channel) return; // announcements go through sendAnnouncement
      const [{ superIds, disabled }, holders] = await Promise.all([baseAudience(), grantHolders(channel.grant)]);
      const audience = [...superIds, ...holders].filter((id) => !disabled.has(id) && id !== String(actorUserId ?? ''));
      await sendToUsers(audience, channel.name, body ? `${title} — ${body}` : title, channelId);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[alert-push] channel push failed:', (e as Error).message);
    }
  },

  // Announcement → its recipient list; '*' = every active app user. Author excluded.
  async sendAnnouncement(recipients: string[], title: string, body: string, byName: string, byUserId: string): Promise<void> {
    try {
      const { disabled } = await baseAudience();
      let ids: string[];
      if (recipients.includes('*')) {
        const users = await crmRepo.listUsers({ status: 'active' });
        ids = users.filter((u) => u.access?.app !== false).map((u) => String(u._id));
      } else {
        ids = recipients;
      }
      const audience = ids.filter((id) => !disabled.has(id) && id !== byUserId);
      await sendToUsers(audience, `📢 ${byName}`, body ? `${title} — ${body}` : title, 'announcements');
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[alert-push] announcement push failed:', (e as Error).message);
    }
  },

  // Personal "User Alerts" event → push to just that one user (their own attendance etc.).
  // Unlike a channel event, the subject IS the recipient, so we never exclude them.
  async sendUserAlert(userId: string, title: string, body: string): Promise<void> {
    try {
      const { disabled } = await baseAudience();
      if (disabled.has(String(userId))) return; // app access revoked → no push
      await sendToUsers([userId], 'My Alerts', body ? `${title} — ${body}` : title, USER_ALERTS_CHANNEL_ID);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[alert-push] user alert push failed:', (e as Error).message);
    }
  },
};
