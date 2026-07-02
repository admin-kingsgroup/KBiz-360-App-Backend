import { Types } from 'mongoose';
import { ConversationModel, MessageModel, type ConversationDoc, type MessageDoc } from './chat.models';

const oid = (id: string): Types.ObjectId => new Types.ObjectId(id);

// Repository pattern: all chat data access lives here; the service holds business rules.
export const conversationRepo = {
  create: (data: Partial<ConversationDoc>) => ConversationModel().create(data),
  findById: (id: string) => (Types.ObjectId.isValid(id) ? ConversationModel().findById(id).lean<ConversationDoc>() : Promise.resolve(null)),
  findByDirectKey: (directKey: string) => ConversationModel().findOne({ directKey }).lean<ConversationDoc>(),
  findByDeptKey: (deptKey: string) => ConversationModel().findOne({ deptKey }).lean<ConversationDoc>(),
  listForUser: (userId: string) =>
    ConversationModel().find({ participantIds: userId }).sort({ lastActivityAt: -1 }).limit(200).lean<ConversationDoc[]>(),
  raw: () => ConversationModel(),

  async touchLastMessage(conversationId: string, last: NonNullable<ConversationDoc['lastMessage']>, senderId: string): Promise<void> {
    // Bump activity, set lastMessage, and increment unread for everyone except the sender.
    await ConversationModel().updateOne(
      { _id: oid(conversationId) },
      { $set: { lastMessage: last, lastActivityAt: last.at }, $inc: { 'members.$[other].unread': 1 } },
      { arrayFilters: [{ 'other.userId': { $ne: senderId } }] },
    );
  },
  async markRead(conversationId: string, userId: string, at: Date): Promise<void> {
    await ConversationModel().updateOne(
      { _id: oid(conversationId), 'members.userId': userId },
      { $set: { 'members.$.unread': 0, 'members.$.lastReadAt': at } },
    );
  },
};

export interface MessagePage {
  before?: string; // message id cursor
  limit?: number;
}

export const messageRepo = {
  create: (data: Partial<MessageDoc>) => MessageModel().create(data),
  findByClientId: (conversationId: Types.ObjectId, clientId: string) =>
    MessageModel().findOne({ conversationId, clientId }).lean<MessageDoc>(),
  findById: (id: string) => (Types.ObjectId.isValid(id) ? MessageModel().findById(id) : Promise.resolve(null)),
  findByIdLean: (id: string) => (Types.ObjectId.isValid(id) ? MessageModel().findById(id).lean<MessageDoc>() : Promise.resolve(null)),

  async listByConversation(conversationId: string, userId: string, page: MessagePage): Promise<MessageDoc[]> {
    const q: Record<string, unknown> = { conversationId: oid(conversationId), deletedFor: { $ne: userId } };
    if (page.before && Types.ObjectId.isValid(page.before)) q._id = { $lt: oid(page.before) };
    const limit = Math.min(Math.max(page.limit ?? 30, 1), 100);
    const docs = await MessageModel().find(q).sort({ _id: -1 }).limit(limit).lean<MessageDoc[]>();
    return docs.reverse(); // chronological asc for the client
  },

  pinnedFor: (conversationId: string) =>
    MessageModel().find({ conversationId: oid(conversationId), pinned: true, deletedForEveryone: false }).sort({ pinnedAt: -1 }).lean<MessageDoc[]>(),

  starredFor: (userId: string) =>
    MessageModel().find({ starredBy: userId, deletedFor: { $ne: userId } }).sort({ _id: -1 }).limit(200).lean<MessageDoc[]>(),

  async search(conversationIds: string[], text: string, opts: { senderId?: string } = {}): Promise<MessageDoc[]> {
    const q: Record<string, unknown> = {
      conversationId: { $in: conversationIds.map(oid) },
      deletedForEveryone: false,
      $text: { $search: text },
    };
    if (opts.senderId) q.senderId = opts.senderId;
    return MessageModel().find(q).sort({ _id: -1 }).limit(50).lean<MessageDoc[]>();
  },

  // Mark a batch delivered/read for a given recipient (idempotent via $addToSet).
  async markDelivered(conversationId: string, recipientId: string, at: Date): Promise<string[]> {
    const pending = await MessageModel()
      .find({ conversationId: oid(conversationId), senderId: { $ne: recipientId }, deliveredTo: { $ne: recipientId } })
      .select('_id')
      .lean<{ _id: Types.ObjectId }[]>();
    if (!pending.length) return [];
    await MessageModel().updateMany(
      { _id: { $in: pending.map((m) => m._id) } },
      { $addToSet: { deliveredTo: recipientId }, $set: { status: 'delivered', deliveredAt: at } },
    );
    return pending.map((m) => String(m._id));
  },
  async markRead(conversationId: string, recipientId: string, at: Date): Promise<string[]> {
    const pending = await MessageModel()
      .find({ conversationId: oid(conversationId), senderId: { $ne: recipientId }, 'readBy.userId': { $ne: recipientId } })
      .select('_id')
      .lean<{ _id: Types.ObjectId }[]>();
    if (!pending.length) return [];
    await MessageModel().updateMany(
      { _id: { $in: pending.map((m) => m._id) } },
      { $addToSet: { readBy: { userId: recipientId, at }, deliveredTo: recipientId }, $set: { status: 'read', readAt: at } },
    );
    return pending.map((m) => String(m._id));
  },
};
