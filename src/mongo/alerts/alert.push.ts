import { config } from '../../config';
import { callDeviceRepo } from '../calls/call.repository';
import { crmRepo } from '../crm.repo';
import { appDb } from '../connection';
import { ALERT_CHANNELS, USER_ALERTS_CHANNEL_ID, canonicalBranchCode, type AlertChannelDef } from './alertChannels';
import { alertMutes } from './alertMutes';

// Push notifications for system alerts. The socket 'alert:new' only reaches OPEN apps —
// this is what taps people on the shoulder when the app is closed. Audience per channel
// event = super-admins + the channel's grant holders with access to its branch (any active holder
// for a company-wide channel) + (branch-wide channels) the branch's members — exactly who can see
// it in the feed (channelAudience) — minus
// the acting user; announcements go to
// their recipient list ('*' = everyone). Whoever has muted the channel is left out (alertMutes) —
// they still see the event in the Alerts tab.
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
  channelId: 'general'; // non-badging channel — the app-icon badge is reserved for unread chats
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
export interface Audience {
  at: number;
  superIds: string[];
  disabled: Set<string>;
  companyWideIds: string[]; // super_admin + company_manager (level ≤ 2) — every branch is theirs
  members: { id: string; branchIds: string[] }[]; // everyone else, with their CRM branch_ids
  branchIdsByCode: Map<string, string[]>; // 'BOM' → branch _ids carrying that code
}
let _cache: Audience | null = null;

async function baseAudience(): Promise<Audience> {
  if (_cache && Date.now() - _cache.at < CACHE_MS) return _cache;
  const roles = await crmRepo.listRoles();
  const superRoleIds = new Set(
    roles.filter((r) => r.level === 1 || (r.permissions ?? []).includes('*')).map((r) => String(r._id)),
  );
  // Same rule as access.deriveAccess: a missing role counts as level 5.
  const levelOf = new Map(roles.map((r) => [String(r._id), r.level ?? 5]));
  const users = (await crmRepo.listUsers({ status: 'active' })).filter((u) => u.access?.app !== false);
  const superIds = users.filter((u) => superRoleIds.has(String(u.role_id))).map((u) => String(u._id));
  const companyWideIds: string[] = [];
  const members: Audience['members'] = [];
  for (const u of users) {
    if ((levelOf.get(String(u.role_id)) ?? 5) <= 2) companyWideIds.push(String(u._id));
    else members.push({ id: String(u._id), branchIds: (u.branch_ids ?? []).map(String) });
  }
  const branchIdsByCode = new Map<string, string[]>();
  for (const b of await crmRepo.listBranches({})) {
    const code = canonicalBranchCode(b.code); // HNBO row → the NBO channels
    if (code) branchIdsByCode.set(code, [...(branchIdsByCode.get(code) ?? []), String(b._id)]);
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const disabledDocs = await (appDb().collection('app_access') as any).find({ disabled: true }).toArray();
  const disabled = new Set<string>(disabledDocs.map((d: { userId?: string }) => String(d.userId)));
  _cache = { at: Date.now(), superIds, disabled, companyWideIds, members, branchIdsByCode };
  return _cache;
}

// A branch-wide channel's audience: everyone who belongs to its branch — the same people
// alertGrants.effectiveFor lets see it in the feed.
export function branchMembers(aud: Audience, branchCode: string): string[] {
  const ids = new Set(aud.branchIdsByCode.get(canonicalBranchCode(branchCode)) ?? []);
  return [...aud.companyWideIds, ...aud.members.filter((m) => m.branchIds.some((b) => ids.has(b))).map((m) => m.id)];
}

// Who a channel event reaches: supers, plus the branch's members for a branch-wide channel, or for
// a grant-only one the grant holders WHO HAVE ACCESS TO ITS BRANCH (or hub) — a stored BOM-erp grant
// on an NBO-only user pushes nothing, exactly as alertGrants.effectiveFor shows nothing.
// A company-wide channel (KGD Alerts, 2026-10-07) has no branch: supers plus every grant holder
// who is an active app user (the pool baseAudience read), whatever their branches.
export function channelAudience(aud: Audience, channel: AlertChannelDef, holders: string[]): string[] {
  if (channel.companyWide) {
    const active = new Set([...aud.companyWideIds, ...aud.members.map((m) => m.id)]);
    return [...aud.superIds, ...holders.filter((id) => active.has(id))];
  }
  const inBranch = branchMembers(aud, channel.branchCode);
  if (channel.branchWide) return [...aud.superIds, ...inBranch];
  const mayHold = new Set(inBranch);
  return [...aud.superIds, ...holders.filter((id) => mayHold.has(id))];
}

async function grantHolders(grant: string): Promise<string[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const docs = await (appDb().collection('alert_grants') as any).find({ alerts: grant }).toArray();
  return docs.map((d: { userId?: string }) => String(d.userId));
}

async function sendToUsers(userIds: string[], title: string, text: string, channelId: string): Promise<void> {
  const all = [...new Set(userIds)];
  // A failed mute lookup must not swallow the alert — push to everyone rather than no one.
  const muted = await alertMutes.mutedAmong(channelId, all).catch(() => new Set<string>());
  const unique = all.filter((id) => !muted.has(id));
  if (!unique.length) return;
  const body = text.length > 110 ? `${text.slice(0, 107)}…` : text;
  const tokenLists = await Promise.all(unique.map((id) => callDeviceRepo.tokensForUser(id).catch(() => [] as string[])));
  const messages: ExpoMessage[] = tokenLists.flat().filter(isExpoPushToken).map((to) => ({
    to,
    title,
    body,
    data: { type: 'alert', id: channelId }, // routes to /alert/[channelId] (services/notifications/routes.ts)
    sound: 'default',
    channelId: 'general',
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
  // Channel event → everyone who can see the channel (supers, plus the in-branch grant holders of
  // a grant-only channel or the members of a branch-wide one's branch), minus the actor.
  async sendChannelAlert(channelId: string, title: string, body: string, actorUserId?: string | null): Promise<void> {
    try {
      const channel = ALERT_CHANNELS.find((c) => c.id === channelId);
      if (!channel) return; // announcements go through sendAnnouncement
      // A branch-wide channel reaches its branch only — stored grants for it are ignored, exactly
      // as alertGrants.effectiveFor ignores them for the feed.
      const [aud, holders] = await Promise.all([baseAudience(), channel.branchWide ? [] : grantHolders(channel.grant)]);
      const audience = channelAudience(aud, channel, holders).filter((id) => !aud.disabled.has(id) && id !== String(actorUserId ?? ''));
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
