import { Types } from 'mongoose';
import { config } from '../../config';
import { appDb } from '../connection';
import { getStorage } from '../../storage';
import { crmRepo } from '../crm.repo';
import { accessService } from '../access';
import { userWorkBranches } from '../attendance/userWorkBranches';
import { emitToAll } from '../chat/chat.events';
import { alertGrants } from './alertGrants';
import { alertPush } from './alert.push';
import { ANNOUNCEMENTS_CHANNEL_ID, USER_ALERTS_CHANNEL_ID, visibleChannelIds } from './alertChannels';

// System-alert EVENTS (kb360_app.alert_events). Events are shared per channel; read-state is
// per-user (readBy). The realtime signal carries only the channelId — clients refetch GET /alerts,
// which is access-filtered server-side, so nothing leaks to users outside the channel.
export interface AlertEventDto {
  id: string;
  channelId: string;
  source: string;
  title: string;
  body: string;
  context: string;
  time: number; // epoch ms
  read: boolean;
  attachment?: { name: string; url: string }; // e.g. the ERP's invoice PDF (served from /uploads or S3)
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const col = () => appDb().collection('alert_events') as any;
// Newest events to return PER CHANNEL (not globally). A single global cap starves low-volume
// channels: the once-a-day Receivables/Payables/Bank&Cash pushes were dropped out of the window by
// the high-frequency Accounts/Sales-Invoice/Bookings channels, so those channels showed empty.
const PER_CHANNEL_EVENTS = 50;
const MAX_EVENTS = 1500; // overall safety ceiling on the merged feed

// listFor filters by channelId (and announcements by recipients) sorted by time — index both paths
// now that the ERP/CRM ingest can grow this collection much faster than attendance did. Channel
// events carry expiresAt (90d) so the TTL index bounds storage on the shared Atlas cluster
// (listFor never shows more than the newest 200 anyway); admin announcements deliberately have no
// expiresAt — Mongo TTL skips docs missing the indexed field — so their history never expires.
const EVENT_TTL_DAYS = 90;
export const eventExpiry = (from: Date): Date => new Date(from.getTime() + EVENT_TTL_DAYS * 24 * 3600 * 1000);
export async function ensureAlertIndexes(): Promise<void> {
  await col().createIndex({ channelId: 1, time: -1 });
  await col().createIndex({ time: -1 });
  await col().createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
}

// Wall-clock time in the business timezone (same convention as attendance.service).
const ATTENDANCE_TZ = process.env.ATTENDANCE_TZ || 'Asia/Kolkata';
function fmtWallTime(d: Date): string {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: ATTENDANCE_TZ, hour: 'numeric', minute: '2-digit', hour12: true }).format(d);
  } catch {
    return d.toISOString().slice(11, 16);
  }
}

export const alertService = {
  async record(
    channelId: string,
    // attachment.key = storage key, persisted for future file cleanup; DTO exposes only {name,url}.
    ev: { source: string; title: string; body: string; context: string; attachment?: { name: string; url: string; key?: string } },
    // The user who caused the event (e.g. the puncher) — excluded from the push fan-out.
    actorUserId?: string | null,
  ): Promise<void> {
    const now = new Date();
    await col().insertOne({ channelId, ...ev, time: now, readBy: [], createdAt: now, expiresAt: eventExpiry(now) });
    emitToAll('alert:new', { channelId });
    // Closed apps don't hear the socket — push to everyone who can see this channel.
    void alertPush.sendChannelAlert(channelId, ev.title, ev.body, actorUserId);
  },

  // Personal "User Alerts" event addressed to a single user, with a push to just them.
  async recordUserAlert(userId: string, ev: { source: string; title: string; body: string; context: string }): Promise<void> {
    const now = new Date();
    await col().insertOne({ channelId: USER_ALERTS_CHANNEL_ID, ...ev, recipients: [userId], time: now, readBy: [], createdAt: now, expiresAt: eventExpiry(now) });
    emitToAll('alert:new', { channelId: USER_ALERTS_CHANNEL_ID });
    void alertPush.sendUserAlert(userId, ev.title, ev.body);
  },

  // Attendance punch → the puncher's own "You checked in/out" event in My Alerts (with a push to
  // them). The branch half of this — a live "X checked in" post into the branch Attendance
  // channel — went away 2026-08-19 with those channels: what a branch gets now is ONE day-close
  // summary in its group chat (attendance.service.dayCloseReport), not a message per punch.
  // Never throws — a failed alert must not fail the punch.
  async recordAttendancePunch(userId: string, action: 'in' | 'out', at: Date, via: string | null): Promise<void> {
    try {
      await this.recordUserAlert(userId, {
        source: 'Attendance',
        title: `You checked ${action}`,
        body: `${fmtWallTime(at)}${via ? ` · via ${via}` : ''}`,
        context: 'Your attendance',
      });
    } catch (err) {
      console.error('[alerts] failed to record attendance event', err);
    }
  },

  // Super-admin-composed announcement addressed to specific users (or '*' = everyone).
  async createAnnouncement(byUserId: string, input: { title: string; body: string; recipients: string[] }): Promise<void> {
    const author = await crmRepo.getUserById(byUserId);
    const name = author ? `${author.first_name ?? ''} ${author.last_name ?? ''}`.trim() || author.email || 'Admin' : 'Admin';
    const now = new Date();
    await col().insertOne({
      channelId: ANNOUNCEMENTS_CHANNEL_ID,
      source: name,
      title: input.title,
      body: input.body,
      context: 'Announcement', // no branch token → buckets as company-wide in the app
      recipients: input.recipients,
      time: now,
      readBy: [],
      createdAt: now,
      createdBy: byUserId,
    });
    emitToAll('alert:new', { channelId: ANNOUNCEMENTS_CHANNEL_ID });
    void alertPush.sendAnnouncement(input.recipients, input.title, input.body, name, byUserId);
  },

  // The caller's visible events (newest first), with their personal read flag.
  async listFor(userId: string): Promise<{ events: AlertEventDto[] }> {
    const access = await accessService.accessForUserId(userId);
    if (!access) return { events: [] };
    const grants = await alertGrants.grantsFor(userId);
    const channelIds = visibleChannelIds(access.isSuper, grants);
    // Supers: every registered channel + the full announcements history.
    // Everyone else: announcements addressed to them (directly or via '*') PLUS any
    // channels a super-admin granted them (visibleChannelIds honors alertGrants).
    const visible: object[] = access.isSuper
      ? [{ channelId: { $in: [...channelIds, ANNOUNCEMENTS_CHANNEL_ID] } }]
      : [{ channelId: ANNOUNCEMENTS_CHANNEL_ID, recipients: { $in: [userId, '*'] } }];
    if (!access.isSuper && channelIds.length) visible.push({ channelId: { $in: channelIds } });
    // Personal "User Alerts" — every user (supers included) sees only their own, by recipient.
    visible.push({ channelId: USER_ALERTS_CHANNEL_ID, recipients: userId });
    // Newest PER_CHANNEL_EVENTS from EACH visible channel, then merged newest-first. This keeps
    // low-frequency channels (the daily AR/AP/Bank&Cash pushes) visible even when busy channels emit
    // hundreds of newer events the same day — a plain global `.limit(N)` starved them.
    const docs = await col().aggregate([
      { $match: { $or: visible } },
      { $sort: { time: -1 } },
      { $group: { _id: '$channelId', docs: { $push: '$$ROOT' } } },
      { $project: { docs: { $slice: ['$docs', PER_CHANNEL_EVENTS] } } },
      { $unwind: '$docs' },
      { $replaceRoot: { newRoot: '$docs' } },
      { $sort: { time: -1 } },
      { $limit: MAX_EVENTS },
    ]).toArray();
    return {
      events: docs.map((d: { _id: unknown; channelId: string; source: string; title: string; body: string; context: string; time: Date; readBy?: string[]; attachment?: { name: string; url: string } }) => ({
        id: String(d._id),
        channelId: d.channelId,
        source: d.source,
        title: d.title,
        body: d.body,
        context: d.context,
        time: new Date(d.time).getTime(),
        read: (d.readBy ?? []).includes(userId),
        ...(d.attachment ? { attachment: { name: d.attachment.name, url: d.attachment.url } } : {}),
      })),
    };
  },

  // Resolve an event's attachment into a short-lived access URL, enforcing the same
  // visibility as listFor. Legacy events (no storage key) fall back to their stored URL.
  async attachmentUrlFor(userId: string, eventId: string): Promise<{ url: string; name: string } | null> {
    if (!Types.ObjectId.isValid(eventId)) return null;
    const d = await col().findOne({ _id: new Types.ObjectId(eventId) });
    if (!d?.attachment?.url && !d?.attachment?.key) return null;
    const access = await accessService.accessForUserId(userId);
    if (!access) return null;
    if (!access.isSuper) {
      const grants = await alertGrants.grantsFor(userId);
      const channelIds = new Set(visibleChannelIds(false, grants));
      const isAddressedAnnouncement = d.channelId === ANNOUNCEMENTS_CHANNEL_ID
        && (d.recipients ?? []).some((r: string) => r === userId || r === '*');
      if (!channelIds.has(d.channelId) && !isAddressedAnnouncement) return null;
    }
    const name = d.attachment.name ?? 'document.pdf';
    // uploads/* objects are public (chat-media model; also the ingest's fallback prefix when IAM
    // denies alert-attachments/*) — their stored URL is the reliable one, and a presigned GET
    // signed by a user without GetObject there would 403 at fetch time. Sign only private keys.
    if (d.attachment.key && config.storage.driver === 's3' && !String(d.attachment.key).startsWith('uploads/')) {
      try {
        return { url: await getStorage().signedUrl(String(d.attachment.key), 300), name };
      } catch { /* fall back to the stored URL below */ }
    }
    return { url: String(d.attachment.url), name };
  },

  async markRead(userId: string, eventId: string): Promise<void> {
    if (!Types.ObjectId.isValid(eventId)) return;
    await col().updateOne({ _id: new Types.ObjectId(eventId) }, { $addToSet: { readBy: userId } });
  },

  async markChannelRead(userId: string, channelId: string): Promise<void> {
    // User Alerts is a shared channel of per-user events — only mark the caller's own read.
    const filter = channelId === USER_ALERTS_CHANNEL_ID ? { channelId, recipients: userId } : { channelId };
    await col().updateMany(filter, { $addToSet: { readBy: userId } });
  },
};
