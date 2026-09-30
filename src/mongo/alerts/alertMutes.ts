import { appDb } from '../connection';
import { ALERT_CHANNELS, ANNOUNCEMENTS_CHANNEL_ID, USER_ALERTS_CHANNEL_ID } from './alertChannels';

// Per-user alert MUTES (owner, 2026-09-30: "give option to mute the alerts so that we can mute it
// on the respective user's device"). Personal and self-service — each user mutes for themselves,
// unlike alert_grants, which a super-admin sets for others. A muted channel still lists its events
// in the Alerts tab; it only stops PUSHING to that user, exactly like muting a chat.
// One doc per (userId, channelId). until = null ⇒ muted until unmuted ("Always"); a date ⇒ until
// then. A timed mute that has run out is ignored on every read and reaped later by the TTL index.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const col = () => appDb().collection('alert_mutes') as any;

// Every channel a user can mute: the registered alert channels plus the two per-event ones.
const MUTABLE_CHANNEL_IDS = new Set<string>([...ALERT_CHANNELS.map((c) => c.id), USER_ALERTS_CHANNEL_ID, ANNOUNCEMENTS_CHANNEL_ID]);
export const isMutableChannel = (channelId: string): boolean => MUTABLE_CHANNEL_IDS.has(channelId);

// channelId → epoch ms the mute ends, or null for "Always". Only mutes still running are listed.
export type AlertMuteMap = Record<string, number | null>;

// When a mute set now for `hours` ends; null/absent hours = "Always" (same rule as the chat mute).
export const muteUntil = (hours: number | null | undefined, now: number): Date | null =>
  hours ? new Date(now + hours * 3600_000) : null;

export const isMuteRunning = (until: Date | null | undefined, now: number): boolean =>
  until == null || new Date(until).getTime() > now;

export function activeMuteMap(docs: { channelId: string; until?: Date | null }[], now: number): AlertMuteMap {
  const out: AlertMuteMap = {};
  for (const d of docs) if (isMuteRunning(d.until, now)) out[d.channelId] = d.until ? new Date(d.until).getTime() : null;
  return out;
}

export async function ensureAlertMuteIndexes(): Promise<void> {
  await col().createIndex({ userId: 1, channelId: 1 }, { unique: true });
  await col().createIndex({ channelId: 1, userId: 1 }); // the push fan-out asks per channel
  // TTL skips docs whose `until` is not a date, so "Always" mutes (null) never expire.
  await col().createIndex({ until: 1 }, { expireAfterSeconds: 0 });
}

export const alertMutes = {
  async activeFor(userId: string): Promise<AlertMuteMap> {
    return activeMuteMap(await col().find({ userId }).toArray(), Date.now());
  },

  // Mute (for `hours`, or always) or unmute a set of channels — one card in the app can stand for
  // several branch channels (ERP = BOM + AMD + …). Unknown channel ids are dropped.
  async set(userId: string, channelIds: string[], muted: boolean, hours?: number | null): Promise<AlertMuteMap> {
    const ids = [...new Set(channelIds)].filter(isMutableChannel);
    if (ids.length) {
      if (muted) {
        const until = muteUntil(hours, Date.now());
        await col().bulkWrite(ids.map((channelId) => ({
          updateOne: { filter: { userId, channelId }, update: { $set: { userId, channelId, until, updatedAt: new Date() } }, upsert: true },
        })));
      } else {
        await col().deleteMany({ userId, channelId: { $in: ids } });
      }
    }
    return this.activeFor(userId);
  },

  // Of `userIds`, the ones who have `channelId` muted right now — the push fan-out leaves them out.
  async mutedAmong(channelId: string, userIds: string[]): Promise<Set<string>> {
    if (!userIds.length) return new Set();
    const docs = await col().find({ channelId, userId: { $in: userIds } }, { projection: { userId: 1, until: 1 } }).toArray();
    const now = Date.now();
    return new Set(docs.filter((d: { until?: Date | null }) => isMuteRunning(d.until, now)).map((d: { userId: string }) => String(d.userId)));
  },
};
