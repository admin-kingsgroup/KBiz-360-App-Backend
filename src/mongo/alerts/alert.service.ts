import { Types } from 'mongoose';
import { appDb } from '../connection';
import { crmRepo } from '../crm.repo';
import { accessService } from '../access';
import { userWorkBranches } from '../attendance/userWorkBranches';
import { emitToAll } from '../chat/chat.events';
import { alertGrants } from './alertGrants';
import { channelForBranchCode, visibleChannelIds } from './alertChannels';

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
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const col = () => appDb().collection('alert_events') as any;
const MAX_EVENTS = 200;

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
  async record(channelId: string, ev: { source: string; title: string; body: string; context: string }): Promise<void> {
    const now = new Date();
    await col().insertOne({ channelId, ...ev, time: now, readBy: [], createdAt: now });
    emitToAll('alert:new', { channelId });
  },

  // Attendance punch → an event in that branch's attendance channel. Never throws — a failed
  // alert must not fail the punch.
  async recordAttendancePunch(userId: string, action: 'in' | 'out', at: Date, via: string | null): Promise<void> {
    try {
      const user = await crmRepo.getUserById(userId);
      if (!user) return;
      // The user's WORKING branch: explicit assignment → first CRM access branch (same rule as team view).
      const firstBranch = (user.branch_ids ?? [])[0];
      const workBranchId = (await userWorkBranches.branchIdFor(userId)) ?? (firstBranch ? String(firstBranch) : null);
      if (!workBranchId || !Types.ObjectId.isValid(workBranchId)) return;
      const [branch] = await crmRepo.branchesByIds([new Types.ObjectId(workBranchId)]);
      const channel = channelForBranchCode(branch?.code ?? null);
      if (!channel) return; // only branches with an attendance channel (BOM/AMD) emit alerts
      const name = `${user.first_name ?? ''} ${user.last_name ?? ''}`.trim() || user.email || 'Unknown';
      await this.record(channel.id, {
        source: 'Attendance System',
        title: `${name} checked ${action}`,
        body: `${fmtWallTime(at)}${via ? ` · via ${via}` : ''}`,
        context: `TK ${channel.branchCode} · Attendance`,
      });
    } catch (err) {
      console.error('[alerts] failed to record attendance event', err);
    }
  },

  // The caller's visible events (newest first), with their personal read flag.
  async listFor(userId: string): Promise<{ events: AlertEventDto[] }> {
    const access = await accessService.accessForUserId(userId);
    if (!access) return { events: [] };
    const grants = await alertGrants.grantsFor(userId);
    const channelIds = visibleChannelIds(access.isSuper, grants);
    if (!channelIds.length) return { events: [] };
    const docs = await col().find({ channelId: { $in: channelIds } }).sort({ time: -1 }).limit(MAX_EVENTS).toArray();
    return {
      events: docs.map((d: { _id: unknown; channelId: string; source: string; title: string; body: string; context: string; time: Date; readBy?: string[] }) => ({
        id: String(d._id),
        channelId: d.channelId,
        source: d.source,
        title: d.title,
        body: d.body,
        context: d.context,
        time: new Date(d.time).getTime(),
        read: (d.readBy ?? []).includes(userId),
      })),
    };
  },

  async markRead(userId: string, eventId: string): Promise<void> {
    if (!Types.ObjectId.isValid(eventId)) return;
    await col().updateOne({ _id: new Types.ObjectId(eventId) }, { $addToSet: { readBy: userId } });
  },

  async markChannelRead(userId: string, channelId: string): Promise<void> {
    await col().updateMany({ channelId }, { $addToSet: { readBy: userId } });
  },
};
