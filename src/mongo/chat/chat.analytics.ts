import { Types } from 'mongoose';
import { MessageModel, ConversationModel } from './chat.models';
import { crmRepo } from '../crm.repo';

const startOfToday = (): Date => { const d = new Date(); d.setUTCHours(0, 0, 0, 0); return d; };
const daysAgo = (n: number): Date => new Date(Date.now() - n * 86_400_000);

async function resolveNames(ids: string[]): Promise<Record<string, string>> {
  const valid = [...new Set(ids)].filter((id) => Types.ObjectId.isValid(id)).map((id) => new Types.ObjectId(id));
  const users = await crmRepo.listUsers({ _id: { $in: valid } });
  const map: Record<string, string> = {};
  for (const u of users) map[String(u._id)] = `${u.first_name ?? ''} ${u.last_name ?? ''}`.trim() || u.email;
  return map;
}

// Chat analytics over kb360_app (Super-Admin only). MongoDB aggregations on messages/conversations.
export const chatAnalytics = {
  async overview() {
    const Msg = MessageModel();
    const Conv = ConversationModel();
    const today = startOfToday();
    const monthAgo = daysAgo(30);

    const [messagesTotal, messagesToday, directCount, groupCount, byType, dau, mau, topUsers, perDay] = await Promise.all([
      Msg.countDocuments({}),
      Msg.countDocuments({ createdAt: { $gte: today } }),
      Conv.countDocuments({ type: 'direct' }),
      Conv.countDocuments({ type: 'group' }),
      Msg.aggregate<{ _id: string; count: number }>([{ $group: { _id: '$type', count: { $sum: 1 } } }]),
      Msg.distinct('senderId', { createdAt: { $gte: today } }),
      Msg.distinct('senderId', { createdAt: { $gte: monthAgo } }),
      Msg.aggregate<{ _id: string; count: number }>([{ $group: { _id: '$senderId', count: { $sum: 1 } } }, { $sort: { count: -1 } }, { $limit: 10 }]),
      Msg.aggregate<{ _id: string; count: number }>([
        { $match: { createdAt: { $gte: daysAgo(7) } } },
        { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }, count: { $sum: 1 } } },
        { $sort: { _id: 1 } },
      ]),
    ]);

    const mediaUsage: Record<string, number> = { text: 0, image: 0, video: 0, document: 0, voice: 0 };
    for (const t of byType) mediaUsage[t._id] = t.count;

    const groups = await Conv.find({ type: 'group' }).select('_id name').lean<{ _id: Types.ObjectId; name: string }[]>();
    const groupIds = groups.map((g) => g._id);
    const topGroups = groupIds.length
      ? await Msg.aggregate<{ _id: Types.ObjectId; count: number }>([
          { $match: { conversationId: { $in: groupIds } } },
          { $group: { _id: '$conversationId', count: { $sum: 1 } } },
          { $sort: { count: -1 } },
          { $limit: 10 },
        ])
      : [];
    const groupName = new Map(groups.map((g) => [String(g._id), g.name] as const));

    const names = await resolveNames(topUsers.map((u) => u._id));

    return {
      messagesSent: messagesTotal,
      messagesToday,
      // "received" ≈ total deliveries; using message total as the platform-wide volume signal.
      dau: dau.length,
      mau: mau.length,
      conversations: { direct: directCount, group: groupCount, total: directCount + groupCount },
      mediaUsage,
      messagesPerDay: perDay.map((d) => ({ date: d._id, count: d.count })),
      mostActiveUsers: topUsers.map((u) => ({ userId: u._id, name: names[u._id] ?? u._id, count: u.count })),
      mostActiveGroups: topGroups.map((g) => ({ conversationId: String(g._id), name: groupName.get(String(g._id)) ?? 'Group', count: g.count })),
      generatedAt: new Date().toISOString(),
    };
  },
};
