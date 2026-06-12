import { Types } from 'mongoose';
import {
  ActiveCallModel,
  CallLogModel,
  PushDeviceModel,
  type ActiveCallDoc,
  type CallLogDoc,
} from './call.models';

const oid = (id: string): Types.ObjectId | null => (Types.ObjectId.isValid(id) ? new Types.ObjectId(id) : null);

// ───────────── active_calls ─────────────
export const activeCallRepo = {
  create: (data: Partial<ActiveCallDoc>) => ActiveCallModel().create(data),
  byCallId: (callId: string) => ActiveCallModel().findOne({ callId }).lean<ActiveCallDoc>(),

  // Any in-flight call this user is part of (used to block duplicate / overlapping calls).
  activeForUser: (userId: string) =>
    ActiveCallModel()
      .findOne({ $or: [{ callerId: userId }, { receiverId: userId }], status: { $in: ['ringing', 'accepted'] } })
      .lean<ActiveCallDoc>(),

  update: (callId: string, set: Partial<ActiveCallDoc>) => ActiveCallModel().updateOne({ callId }, { $set: set }),
  remove: (callId: string) => ActiveCallModel().deleteOne({ callId }),
};

// ───────────── call_logs ─────────────
export interface HistoryPage { limit?: number; before?: string }

export const callLogRepo = {
  insert: (data: Partial<CallLogDoc>) => CallLogModel().create(data),
  byCallId: (callId: string) => CallLogModel().findOne({ callId }).lean<CallLogDoc>(),
  byId: (id: string) => (oid(id) ? CallLogModel().findById(id).lean<CallLogDoc>() : Promise.resolve(null)),

  async history(userId: string, page: HistoryPage): Promise<CallLogDoc[]> {
    const q: Record<string, unknown> = { $or: [{ callerId: userId }, { receiverId: userId }] };
    if (page.before && oid(page.before)) q._id = { $lt: oid(page.before) };
    const limit = Math.min(Math.max(page.limit ?? 30, 1), 100);
    return CallLogModel().find(q).sort({ _id: -1 }).limit(limit).lean<CallLogDoc[]>();
  },
};

// ───────────── push_devices (Mongo-only Expo push registry) ─────────────
export const callDeviceRepo = {
  upsert: (userId: string, expoPushToken: string, platform: string | null) =>
    PushDeviceModel().updateOne(
      { expoPushToken },
      { $set: { userId, platform, updatedAt: new Date() }, $setOnInsert: { createdAt: new Date() } },
      { upsert: true },
    ),
  async tokensForUser(userId: string): Promise<string[]> {
    const rows = await PushDeviceModel().find({ userId }).select('expoPushToken').lean<{ expoPushToken: string }[]>();
    return rows.map((r) => r.expoPushToken);
  },
};

// ───────────── analytics (aggregations over call_logs) ─────────────
export interface AnalyticsFilter { from?: number; to?: number; userId?: string }

function matchStage(f: AnalyticsFilter): Record<string, unknown> {
  const m: Record<string, unknown> = {};
  if (f.from || f.to) {
    const range: Record<string, Date> = {};
    if (f.from) range.$gte = new Date(f.from);
    if (f.to) range.$lte = new Date(f.to);
    m.createdAt = range;
  }
  if (f.userId) m.$or = [{ callerId: f.userId }, { receiverId: f.userId }];
  return m;
}

export interface CallSummary {
  total: number;
  completed: number;
  missed: number;
  rejected: number;
  failed: number;
  avgDurationSec: number;
}

export interface CallBucket { period: string; total: number; completed: number; missed: number; durationSec: number }
export interface PerUserUsage { userId: string; total: number; completed: number; missed: number; durationSec: number }

const countIf = (status: string) => ({ $sum: { $cond: [{ $eq: ['$status', status] }, 1, 0] } });

export const callAnalyticsRepo = {
  async summary(f: AnalyticsFilter): Promise<CallSummary> {
    const [row] = await CallLogModel().aggregate<CallSummary & { _id: null }>([
      { $match: matchStage(f) },
      {
        $group: {
          _id: null,
          total: { $sum: 1 },
          completed: countIf('completed'),
          missed: countIf('missed'),
          rejected: countIf('rejected'),
          failed: countIf('failed'),
          // average duration over connected (completed) calls only
          avgDurationSec: { $avg: { $cond: [{ $eq: ['$status', 'completed'] }, '$durationSec', null] } },
        },
      },
    ]);
    return {
      total: row?.total ?? 0,
      completed: row?.completed ?? 0,
      missed: row?.missed ?? 0,
      rejected: row?.rejected ?? 0,
      failed: row?.failed ?? 0,
      avgDurationSec: Math.round(row?.avgDurationSec ?? 0),
    };
  },

  buckets(f: AnalyticsFilter, unit: 'day' | 'month'): Promise<CallBucket[]> {
    const fmt = unit === 'day' ? '%Y-%m-%d' : '%Y-%m';
    return CallLogModel().aggregate<CallBucket>([
      { $match: matchStage(f) },
      {
        $group: {
          _id: { $dateToString: { format: fmt, date: '$createdAt' } },
          total: { $sum: 1 },
          completed: countIf('completed'),
          missed: countIf('missed'),
          durationSec: { $sum: '$durationSec' },
        },
      },
      { $project: { _id: 0, period: '$_id', total: 1, completed: 1, missed: 1, durationSec: 1 } },
      { $sort: { period: 1 } },
    ]);
  },

  perUser(f: AnalyticsFilter): Promise<PerUserUsage[]> {
    return CallLogModel().aggregate<PerUserUsage>([
      { $match: matchStage(f) },
      { $project: { participants: ['$callerId', '$receiverId'], status: 1, durationSec: 1 } },
      { $unwind: '$participants' },
      {
        $group: {
          _id: '$participants',
          total: { $sum: 1 },
          completed: countIf('completed'),
          missed: countIf('missed'),
          durationSec: { $sum: '$durationSec' },
        },
      },
      { $project: { _id: 0, userId: '$_id', total: 1, completed: 1, missed: 1, durationSec: 1 } },
      { $sort: { total: -1 } },
      { $limit: 100 },
    ]);
  },
};
