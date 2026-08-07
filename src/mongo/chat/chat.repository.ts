import { Types } from 'mongoose';
import { ChatSettingsModel, ConversationModel, MessageModel, type ChatSettingsDoc, type ConvMember, type ConversationDoc, type MessageDoc } from './chat.models';

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
  // `lastMessage` is a denormalised snapshot of the text, so deleting a message for
  // everyone has to tombstone it here too — otherwise the deleted words keep showing
  // in every participant's chat-list preview. No-op unless the row still points at it.
  async tombstoneLastMessage(conversationId: Types.ObjectId, messageId: Types.ObjectId, text: string): Promise<void> {
    await ConversationModel().updateOne(
      { _id: conversationId, 'lastMessage.messageId': messageId },
      { $set: { 'lastMessage.text': text, 'lastMessage.type': 'system' } },
    );
  },
  // Per-member chat settings (mute / archive / pin). Only the caller's own member row is touched, so
  // muting a group is personal — exactly like WhatsApp, where mute is yours and not the group's.
  async setMemberSettings(conversationId: string, userId: string, patch: Partial<Pick<ConvMember, 'muted' | 'mutedUntil' | 'archived' | 'pinned'>>): Promise<void> {
    const $set: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(patch)) $set[`members.$.${k}`] = v;
    if (!Object.keys($set).length) return;
    await ConversationModel().updateOne({ _id: oid(conversationId), 'members.userId': userId }, { $set });
  },

  // Disappearing messages are a property of the CHAT (everyone in it), not of one member.
  async setDisappearing(conversationId: string, seconds: number | null): Promise<void> {
    await ConversationModel().updateOne({ _id: oid(conversationId) }, { $set: { disappearAfterSec: seconds } });
  },

  async markRead(conversationId: string, userId: string, at: Date): Promise<void> {
    await ConversationModel().updateOne(
      { _id: oid(conversationId), 'members.userId': userId },
      { $set: { 'members.$.unread': 0, 'members.$.lastReadAt': at } },
    );
  },
  // App-icon badge for one member: number of conversations with unread messages, excluding muted
  // ones — the same formula the client uses (WhatsApp counts chats, not messages). Feeds aps.badge
  // on chat pushes: iOS never runs JS for alert pushes, so the payload is the only way to keep the
  // icon badge current while the app is killed/backgrounded.
  unreadChatCount: (userId: string): Promise<number> =>
    ConversationModel().countDocuments({ participantIds: userId, members: { $elemMatch: { userId, unread: { $gt: 0 }, muted: { $ne: true } } } }),

  // Whether this member currently has the chat muted, honouring a timed mute that has run out.
  async isMuted(conversationId: Types.ObjectId, userId: string): Promise<boolean> {
    const conv = await ConversationModel().findOne(
      { _id: conversationId },
      { members: { $elemMatch: { userId } } },
    ).lean<ConversationDoc>();
    const me = conv?.members?.[0];
    if (!me?.muted) return false;
    return !me.mutedUntil || me.mutedUntil.getTime() > Date.now();
  },
};

export interface MessagePage {
  before?: string; // message id cursor — page BACKWARDS into history (scrollback)
  after?: string;  // message id cursor — only messages NEWER than this (delta sync for local-first clients)
  limit?: number;
}

// ── aggregate receipt status (WhatsApp semantics) ──
export type ReceiptStatus = MessageDoc['status'];
export interface ReceiptResult { ids: string[]; statuses: { id: string; status: ReceiptStatus }[] }
const STATUS_RANK: Record<ReceiptStatus, number> = { sent: 0, delivered: 1, read: 2 };

// 'read' once ANY other participant read, 'delivered' once any other participant has it, else
// 'sent'. A read receipt implies delivery. Any-member semantics are a product decision (2026-07):
// in a group the sender's tick goes double as soon as ONE member has seen the message — waiting
// for every member left group ticks stuck on 'sent' whenever anyone stayed offline. A direct chat
// has a single other participant, so any == every there. (Also used by scripts/backfill-receipt-status.ts.)
export function aggregateStatus(
  m: { senderId: string; deliveredTo?: string[] | null; readBy?: { userId: string }[] | null },
  participantIds: string[],
): ReceiptStatus {
  const others = participantIds.filter((p) => p !== m.senderId);
  if (!others.length) return 'read'; // solo roster — nothing can be pending
  const readSet = new Set((m.readBy ?? []).map((r) => r.userId));
  const delivSet = new Set([...(m.deliveredTo ?? []), ...readSet]);
  if (others.some((o) => readSet.has(o))) return 'read';
  if (others.some((o) => delivSet.has(o))) return 'delivered';
  return 'sent';
}

// Recompute + persist the aggregate for a batch of messages. MONOTONIC: stored status only ever
// moves up (a roster change never downgrades a read tick); deliveredAt/readAt are stamped when the
// aggregate FIRST reaches that state. Returns the post-update authoritative status of every message.
async function applyAggregates(ids: Types.ObjectId[], participantIds: string[], at: Date): Promise<ReceiptResult> {
  const msgs = await MessageModel()
    .find({ _id: { $in: ids } })
    .select('_id senderId deliveredTo readBy status deliveredAt readAt')
    .lean<Pick<MessageDoc, '_id' | 'senderId' | 'deliveredTo' | 'readBy' | 'status' | 'deliveredAt' | 'readAt'>[]>();
  const statuses: ReceiptResult['statuses'] = [];
  const buckets = new Map<string, { ids: Types.ObjectId[]; set: Partial<MessageDoc> }>(); // group identical $set docs into one updateMany
  for (const m of msgs) {
    const cur: ReceiptStatus = m.status ?? 'sent';
    const agg = aggregateStatus(m, participantIds);
    const next = STATUS_RANK[agg] > STATUS_RANK[cur] ? agg : cur;
    statuses.push({ id: String(m._id), status: next });
    if (next === cur) continue;
    const set: Partial<MessageDoc> = { status: next };
    if (!m.deliveredAt) set.deliveredAt = at; // first time past 'sent' (a sent→read jump stamps both)
    if (next === 'read' && !m.readAt) set.readAt = at;
    const key = JSON.stringify(set);
    const b = buckets.get(key);
    if (b) b.ids.push(m._id);
    else buckets.set(key, { ids: [m._id], set });
  }
  if (buckets.size) {
    await MessageModel().bulkWrite(
      [...buckets.values()].map((b) => ({ updateMany: { filter: { _id: { $in: b.ids } }, update: { $set: b.set } } })),
      { ordered: false },
    );
  }
  return { ids: statuses.map((s) => s.id), statuses };
}

export const messageRepo = {
  create: (data: Partial<MessageDoc>) => MessageModel().create(data),
  findByClientId: (conversationId: Types.ObjectId, clientId: string) =>
    MessageModel().findOne({ conversationId, clientId }).lean<MessageDoc>(),
  findById: (id: string) => (Types.ObjectId.isValid(id) ? MessageModel().findById(id) : Promise.resolve(null)),
  findByIdLean: (id: string) => (Types.ObjectId.isValid(id) ? MessageModel().findById(id).lean<MessageDoc>() : Promise.resolve(null)),

  async listByConversation(conversationId: string, userId: string, page: MessagePage): Promise<MessageDoc[]> {
    const q: Record<string, unknown> = { conversationId: oid(conversationId), deletedFor: { $ne: userId } };
    // ObjectIds are monotonic, so the id cursor doubles as a time cursor either way.
    // `after` wins when both are sent (a delta sync never pages backwards).
    if (page.after && Types.ObjectId.isValid(page.after)) q._id = { $gt: oid(page.after) };
    else if (page.before && Types.ObjectId.isValid(page.before)) q._id = { $lt: oid(page.before) };
    const limit = Math.min(Math.max(page.limit ?? 30, 1), 100);
    // Delta sync wants the OLDEST unseen messages first (so a gap fills forward from the cursor);
    // scrollback wants the newest before the cursor. Both are returned chronological asc.
    if (page.after) return MessageModel().find(q).sort({ _id: 1 }).limit(limit).lean<MessageDoc[]>();
    const docs = await MessageModel().find(q).sort({ _id: -1 }).limit(limit).lean<MessageDoc[]>();
    return docs.reverse(); // chronological asc for the client
  },

  // Catch-up feed for local-first clients: every message across `conversationIds` whose document
  // changed after `since` — new arrivals AND in-place changes (edit, delete-for-everyone, reaction,
  // delivered/read ticks), which is why it keys on updatedAt rather than the _id/creation cursor.
  // Ordered oldest-change-first so the client can advance its watermark page by page.
  // The cursor is (updatedAt, _id), not updatedAt alone. updatedAt has millisecond resolution and a
  // receipt bulkWrite stamps EVERY message it touches with the same instant — so a page boundary
  // falling inside such a batch would leave the remainder permanently behind a `$gt` watermark. The
  // id tiebreak resumes exactly where the previous page stopped: nothing skipped, nothing repeated.
  changedSince(conversationIds: Types.ObjectId[], userId: string, since: Date, sinceId: string | undefined, limit: number): Promise<MessageDoc[]> {
    if (!conversationIds.length) return Promise.resolve([]);
    const cursor = sinceId && Types.ObjectId.isValid(sinceId)
      ? { $or: [{ updatedAt: { $gt: since } }, { updatedAt: since, _id: { $gt: oid(sinceId) } }] }
      : { updatedAt: { $gt: since } };
    return MessageModel()
      .find({ conversationId: { $in: conversationIds }, deletedFor: { $ne: userId }, ...cursor })
      .sort({ updatedAt: 1, _id: 1 })
      .limit(Math.min(Math.max(limit, 1), 500))
      .lean<MessageDoc[]>();
  },

  pinnedFor: (conversationId: string) =>
    MessageModel().find({ conversationId: oid(conversationId), pinned: true, deletedForEveryone: false }).sort({ pinnedAt: -1 }).lean<MessageDoc[]>(),

  starredFor: (userId: string) =>
    MessageModel().find({ starredBy: userId, deletedFor: { $ne: userId } }).sort({ _id: -1 }).limit(200).lean<MessageDoc[]>(),

  // Case-insensitive SUBSTRING match, not the $text index: $text only matches whole stemmed words,
  // so "invo" would never find "invoice" — the wrong semantics for a chat search box. The regex scan
  // is bounded by the conversationId index (only the caller's own conversations), and the pattern is
  // escaped so user input can never become a pathological regex.
  async search(conversationIds: string[], userId: string, text: string, opts: { senderId?: string; before?: string } = {}): Promise<MessageDoc[]> {
    const escaped = text.slice(0, 200).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const q: Record<string, unknown> = {
      conversationId: { $in: conversationIds.map(oid) },
      deletedForEveryone: false,
      deletedFor: { $ne: userId }, // deleted-for-me must not resurface in search results
      text: { $regex: escaped, $options: 'i' },
    };
    if (opts.senderId) q.senderId = opts.senderId;
    if (opts.before && Types.ObjectId.isValid(opts.before)) q._id = { $lt: oid(opts.before) };
    return MessageModel().find(q).sort({ _id: -1 }).limit(50).lean<MessageDoc[]>();
  },

  // Mark a batch delivered/read for a given recipient (idempotent via $addToSet), then recompute
  // each message's AGGREGATE status against the conversation roster. System messages carry no receipts.
  async markDelivered(conversationId: string, recipientId: string, participantIds: string[], at: Date): Promise<ReceiptResult> {
    const pending = await MessageModel()
      .find({ conversationId: oid(conversationId), senderId: { $ne: recipientId }, deliveredTo: { $ne: recipientId }, type: { $ne: 'system' } })
      .select('_id')
      .lean<{ _id: Types.ObjectId }[]>();
    if (!pending.length) return { ids: [], statuses: [] };
    const ids = pending.map((m) => m._id);
    await MessageModel().updateMany({ _id: { $in: ids } }, { $addToSet: { deliveredTo: recipientId } });
    return applyAggregates(ids, participantIds, at);
  },
  async markRead(conversationId: string, recipientId: string, participantIds: string[], at: Date): Promise<ReceiptResult> {
    const pending = await MessageModel()
      .find({ conversationId: oid(conversationId), senderId: { $ne: recipientId }, 'readBy.userId': { $ne: recipientId }, type: { $ne: 'system' } })
      .select('_id')
      .lean<{ _id: Types.ObjectId }[]>();
    if (!pending.length) return { ids: [], statuses: [] };
    const ids = pending.map((m) => m._id);
    await MessageModel().updateMany({ _id: { $in: ids } }, { $addToSet: { readBy: { userId: recipientId, at }, deliveredTo: recipientId } });
    return applyAggregates(ids, participantIds, at);
  },

  // Delivered-on-connect sweep: mark EVERYTHING pending for this user across their conversations
  // (one find + one addToSet for the lot), then recompute aggregates per conversation (rosters differ).
  async markDeliveredAcross(
    conversations: { id: string; participantIds: string[] }[],
    recipientId: string,
    at: Date,
  ): Promise<{ conversationId: string; ids: string[]; statuses: ReceiptResult['statuses'] }[]> {
    if (!conversations.length) return [];
    const pending = await MessageModel()
      .find({ conversationId: { $in: conversations.map((c) => oid(c.id)) }, senderId: { $ne: recipientId }, deliveredTo: { $ne: recipientId }, type: { $ne: 'system' } })
      .select('_id conversationId')
      .lean<{ _id: Types.ObjectId; conversationId: Types.ObjectId }[]>();
    if (!pending.length) return [];
    await MessageModel().updateMany({ _id: { $in: pending.map((m) => m._id) } }, { $addToSet: { deliveredTo: recipientId } });
    const grouped = new Map<string, Types.ObjectId[]>();
    for (const m of pending) {
      const k = String(m.conversationId);
      const list = grouped.get(k);
      if (list) list.push(m._id);
      else grouped.set(k, [m._id]);
    }
    const rosters = new Map(conversations.map((c) => [c.id, c.participantIds]));
    const out: { conversationId: string; ids: string[]; statuses: ReceiptResult['statuses'] }[] = [];
    for (const [conversationId, ids] of grouped) out.push({ conversationId, ...(await applyAggregates(ids, rosters.get(conversationId) ?? [], at)) });
    return out;
  },
};


// ─────────── per-user chat settings (privacy + blocks) ───────────
const DEFAULT_SETTINGS = { readReceipts: true, lastSeen: 'everyone' as const, blocked: [] as string[] };

export const chatSettingsRepo = {
  async get(userId: string): Promise<Pick<ChatSettingsDoc, 'readReceipts' | 'lastSeen' | 'blocked'>> {
    const doc = await ChatSettingsModel().findOne({ userId }).lean<ChatSettingsDoc>();
    return doc
      ? { readReceipts: doc.readReceipts, lastSeen: doc.lastSeen, blocked: doc.blocked ?? [] }
      : { ...DEFAULT_SETTINGS };
  },

  async update(userId: string, patch: Partial<Pick<ChatSettingsDoc, 'readReceipts' | 'lastSeen'>>) {
    await ChatSettingsModel().updateOne({ userId }, { $set: patch }, { upsert: true });
    return chatSettingsRepo.get(userId);
  },

  async setBlocked(userId: string, otherUserId: string, blocked: boolean) {
    await ChatSettingsModel().updateOne(
      { userId },
      blocked ? { $addToSet: { blocked: otherUserId } } : { $pull: { blocked: otherUserId } },
      { upsert: true },
    );
    return chatSettingsRepo.get(userId);
  },

  // Everyone who has blocked `userId` — the half that matters when DELIVERING (a blocker must not
  // receive), as opposed to the blocker's own list which is checked when they SEND.
  async blockedBy(userId: string): Promise<string[]> {
    const docs = await ChatSettingsModel().find({ blocked: userId }, { userId: 1 }).lean<ChatSettingsDoc[]>();
    return docs.map((d) => d.userId);
  },

  // Read receipts are reciprocal in WhatsApp: turning yours off also stops you seeing anyone else's.
  async readReceiptsEnabled(userId: string): Promise<boolean> {
    return (await chatSettingsRepo.get(userId)).readReceipts;
  },
};
