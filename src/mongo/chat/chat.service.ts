import { Types } from 'mongoose';
import { Forbidden, NotFound, BadRequest } from '../../common/errors';
import { crmRepo } from '../crm.repo';
import { accessService } from '../access';
import { ConversationModel, MessageModel, type ConversationDoc, type MessageDoc, type Attachment } from './chat.models';
import { conversationRepo, messageRepo } from './chat.repository';
import { emitToUsers, isOnline, getLastSeen } from './chat.events';
import { chatPush } from './chat.push';

export const CHAT_EVENTS = {
  RECEIVE: 'chat:receive',
  DELIVERED: 'chat:delivered',
  READ: 'chat:read',
  TYPING: 'chat:typing',
  STOP_TYPING: 'chat:stopTyping',
  EDIT: 'chat:edit',
  DELETE: 'chat:delete',
  REACTION: 'chat:reaction',
  ONLINE: 'chat:online',
  OFFLINE: 'chat:offline',
  PINNED: 'chat:messagePinned',
  STARRED: 'chat:messageStarred',
  CONVERSATION_NEW: 'chat:conversationNew',
  CONVERSATION_UPDATED: 'chat:conversationUpdated',
} as const;

const EDIT_WINDOW_MS = 15 * 60 * 1000; // 15 min
const DELETE_EVERYONE_WINDOW_MS = 60 * 60 * 1000; // 1 h
const directKeyOf = (a: string, b: string): string => [a, b].sort().join('|');

// ── helpers ──
async function resolveUsers(ids: string[]): Promise<Record<string, { id: string; name: string; email: string }>> {
  const valid = [...new Set(ids)].filter((id) => Types.ObjectId.isValid(id)).map((id) => new Types.ObjectId(id));
  const users = await crmRepo.listUsers({ _id: { $in: valid } });
  const map: Record<string, { id: string; name: string; email: string }> = {};
  for (const u of users) {
    const name = `${u.first_name ?? ''} ${u.last_name ?? ''}`.trim() || u.email;
    map[String(u._id)] = { id: String(u._id), name, email: u.email };
  }
  return map;
}

function assertMember(conv: ConversationDoc, userId: string): void {
  if (!conv.participantIds.includes(userId)) throw Forbidden('Not a participant of this conversation');
}
// Group management is allowed for the creator, any promoted group admin, OR a super-admin
// (so a super-admin can curate any group's membership).
async function assertManageGroup(conv: ConversationDoc, userId: string): Promise<void> {
  const m = conv.members.find((x) => x.userId === userId);
  if (conv.createdBy === userId || m?.role === 'admin') return;
  const access = await accessService.accessForUserId(userId);
  if (access?.isSuper) return;
  throw Forbidden('Requires group admin');
}

// Base message payload broadcast over sockets (clients derive `mine`/`starred` locally).
function toMessageBase(m: MessageDoc) {
  const deleted = m.deletedForEveryone;
  return {
    id: String(m._id),
    conversationId: String(m.conversationId),
    senderId: m.senderId,
    type: deleted ? 'system' : m.type,
    text: deleted ? '' : m.text,
    deletedForEveryone: deleted,
    attachments: deleted ? [] : m.attachments,
    replyTo: m.replyTo ? { messageId: String(m.replyTo.messageId), senderId: m.replyTo.senderId, preview: m.replyTo.preview, type: m.replyTo.type } : null,
    forwardedFrom: m.forwardedFrom ? { messageId: String(m.forwardedFrom.messageId), conversationId: String(m.forwardedFrom.conversationId) } : null,
    reactions: m.reactions.map((r) => ({ userId: r.userId, emoji: r.emoji })),
    status: m.status,
    sentAt: m.sentAt,
    deliveredAt: m.deliveredAt,
    readAt: m.readAt,
    pinned: m.pinned,
    edited: m.edited,
    editedAt: m.editedAt,
    createdAt: m.createdAt,
  };
}
// Per-viewer message DTO (REST).
function toMessageDTO(m: MessageDoc, viewerId: string) {
  return { ...toMessageBase(m), mine: m.senderId === viewerId, starred: m.starredBy.includes(viewerId) };
}

export const chatService = {
  // ── conversations ──
  async getOrCreateDirect(userId: string, otherUserId: string) {
    if (userId === otherUserId) throw BadRequest('Cannot message yourself');
    const other = await crmRepo.getUserById(otherUserId);
    if (!other) throw NotFound('User not found');
    const key = directKeyOf(userId, otherUserId);
    let conv = await conversationRepo.findByDirectKey(key);
    if (!conv) {
      const me = await crmRepo.getUserById(userId);
      conv = (await conversationRepo.create({
        type: 'direct',
        participantIds: [userId, otherUserId],
        members: [
          { userId, role: 'member', joinedAt: new Date(), lastReadAt: new Date(), unread: 0, muted: false, archived: false },
          { userId: otherUserId, role: 'member', joinedAt: new Date(), lastReadAt: null, unread: 0, muted: false, archived: false },
        ],
        createdBy: userId,
        tenantId: me?.tenant_id ? String(me.tenant_id) : null,
        directKey: key,
        lastActivityAt: new Date(),
      })) as unknown as ConversationDoc;
      emitToUsers([otherUserId], CHAT_EVENTS.CONVERSATION_NEW, { conversationId: String(conv._id) });
    }
    return this.conversationDTO(conv, userId);
  },

  async listConversations(userId: string) {
    const convs = await conversationRepo.listForUser(userId);
    const otherIds = convs.flatMap((c) => c.participantIds.filter((p) => p !== userId));
    const users = await resolveUsers(otherIds);
    return convs.map((c) => this.buildConvDTO(c, userId, users));
  },

  async conversationDTO(conv: ConversationDoc, userId: string) {
    const users = await resolveUsers(conv.participantIds.filter((p) => p !== userId));
    return this.buildConvDTO(conv, userId, users);
  },

  buildConvDTO(c: ConversationDoc, userId: string, users: Record<string, { id: string; name: string }>) {
    const me = c.members.find((m) => m.userId === userId);
    const base = {
      id: String(c._id),
      type: c.type,
      lastMessage: c.lastMessage,
      unread: me?.unread ?? 0,
      muted: me?.muted ?? false,
      archived: me?.archived ?? false,
      lastActivityAt: c.lastActivityAt,
    };
    if (c.type === 'direct') {
      const otherId = c.participantIds.find((p) => p !== userId) ?? '';
      const other = users[otherId];
      return { ...base, name: other?.name ?? 'Unknown', image: null, otherUserId: otherId, online: isOnline(otherId), lastSeen: getLastSeen(otherId), memberCount: 2 };
    }
    return {
      ...base,
      name: c.name ?? 'Group',
      image: c.image ?? null,
      memberCount: c.participantIds.length,
      myRole: me?.role ?? 'member',
      description: c.description ?? null,
      createdBy: c.createdBy,
      members: c.members.map((m) => ({ userId: m.userId, role: m.role })),
    };
  },

  // ── messages ──
  async getMessages(userId: string, conversationId: string, page: { before?: string; limit?: number }) {
    const conv = await conversationRepo.findById(conversationId);
    if (!conv) throw NotFound('Conversation not found');
    assertMember(conv, userId);
    const msgs = await messageRepo.listByConversation(conversationId, userId, page);
    return msgs.map((m) => toMessageDTO(m, userId));
  },

  async sendMessage(userId: string, conversationId: string, input: { type?: MessageDoc['type']; text?: string; attachments?: Attachment[]; replyToId?: string; clientId?: string }) {
    const conv = await conversationRepo.findById(conversationId);
    if (!conv) throw NotFound('Conversation not found');
    assertMember(conv, userId);

    let replyTo: MessageDoc['replyTo'] = null;
    if (input.replyToId) {
      const r = await messageRepo.findByIdLean(input.replyToId);
      if (r) replyTo = { messageId: r._id, senderId: r.senderId, preview: (r.text || r.type).slice(0, 140), type: r.type };
    }
    const type = input.type ?? (input.attachments?.length ? 'document' : 'text');
    if (type === 'text' && !input.text?.trim()) throw BadRequest('Empty message');

    const now = new Date();
    const created = (await messageRepo.create({
      conversationId: conv._id,
      senderId: userId,
      type,
      text: input.text ?? '',
      attachments: input.attachments ?? [],
      replyTo,
      status: 'sent',
      sentAt: now,
      deliveredTo: [userId],
      readBy: [],
    })) as unknown as MessageDoc;

    const MEDIA_LABEL: Record<string, string> = { image: '📷 Photo', video: '🎥 Video', document: '📄 Document', voice: '🎤 Voice message' };
    const preview = type === 'text' ? created.text.slice(0, 140) : (MEDIA_LABEL[type] ?? `[${type}]`);
    await conversationRepo.touchLastMessage(conversationId, { messageId: created._id, text: preview, type, senderId: userId, at: now }, userId);

    const base = { ...toMessageBase(created), clientId: input.clientId };
    emitToUsers(conv.participantIds, CHAT_EVENTS.RECEIVE, base);

    // Push ALL recipients (best-effort, non-blocking). We deliberately do NOT gate on socket
    // presence: a backgrounded/killed app can stay "online" on the server until its ping times out
    // (~tens of seconds), so gating dropped pushes. Instead we always push, and the CLIENT suppresses
    // the banner only for the conversation it's actively viewing (foreground handler).
    void (async () => {
      try {
        const recipients = conv.participantIds.filter((p) => p !== userId);
        // eslint-disable-next-line no-console
        console.log(`[chat-push] msg type=${type} conv=${conversationId} recipients=${recipients.length}`);
        if (!recipients.length) return;
        const sender = await crmRepo.getUserById(userId);
        const senderName = sender ? `${sender.first_name ?? ''} ${sender.last_name ?? ''}`.trim() || sender.email : 'New message';
        const title = conv.type === 'group' ? (conv.name ?? 'Group') : senderName;
        const body = conv.type === 'group' ? `${senderName}: ${preview}` : preview;
        await Promise.all(recipients.map((r) => chatPush.notifyNewMessage(r, { title, body, conversationId })));
      } catch {
        /* push is best-effort */
      }
    })();

    return toMessageDTO(created, userId);
  },

  async editMessage(userId: string, messageId: string, text: string) {
    const m = await messageRepo.findById(messageId);
    if (!m) throw NotFound('Message not found');
    if (m.senderId !== userId) throw Forbidden('Only the sender can edit');
    if (m.deletedForEveryone) throw BadRequest('Message was deleted');
    if (Date.now() - m.sentAt.getTime() > EDIT_WINDOW_MS) throw BadRequest('Edit window expired');
    m.text = text;
    m.edited = true;
    m.editedAt = new Date();
    await m.save();
    const conv = await conversationRepo.findById(String(m.conversationId));
    emitToUsers(conv?.participantIds ?? [], CHAT_EVENTS.EDIT, { id: String(m._id), conversationId: String(m.conversationId), text, editedAt: m.editedAt });
    return toMessageDTO(m as unknown as MessageDoc, userId);
  },

  async deleteForMe(userId: string, messageId: string) {
    const m = await messageRepo.findById(messageId);
    if (!m) throw NotFound('Message not found');
    if (!m.deletedFor.includes(userId)) { m.deletedFor.push(userId); await m.save(); }
    return { ok: true };
  },

  async deleteForEveryone(userId: string, messageId: string) {
    const m = await messageRepo.findById(messageId);
    if (!m) throw NotFound('Message not found');
    if (m.senderId !== userId) throw Forbidden('Only the sender can delete for everyone');
    if (Date.now() - m.sentAt.getTime() > DELETE_EVERYONE_WINDOW_MS) throw BadRequest('Delete-for-everyone window expired');
    m.deletedForEveryone = true;
    m.text = '';
    m.attachments = [];
    await m.save();
    const conv = await conversationRepo.findById(String(m.conversationId));
    emitToUsers(conv?.participantIds ?? [], CHAT_EVENTS.DELETE, { id: String(m._id), conversationId: String(m.conversationId) });
    return { ok: true };
  },

  async react(userId: string, messageId: string, emoji: string) {
    const m = await messageRepo.findById(messageId);
    if (!m) throw NotFound('Message not found');
    const conv = await conversationRepo.findById(String(m.conversationId));
    if (!conv) throw NotFound('Conversation not found');
    assertMember(conv, userId);
    const existing = m.reactions.find((r) => r.userId === userId && r.emoji === emoji);
    if (existing) m.reactions = m.reactions.filter((r) => !(r.userId === userId && r.emoji === emoji));
    else { m.reactions = m.reactions.filter((r) => r.userId !== userId); m.reactions.push({ userId, emoji, at: new Date() }); }
    await m.save();
    emitToUsers(conv.participantIds, CHAT_EVENTS.REACTION, { id: String(m._id), conversationId: String(m.conversationId), reactions: m.reactions.map((r) => ({ userId: r.userId, emoji: r.emoji })) });
    return { ok: true };
  },

  async markRead(userId: string, conversationId: string) {
    const conv = await conversationRepo.findById(conversationId);
    if (!conv) throw NotFound('Conversation not found');
    assertMember(conv, userId);
    const now = new Date();
    const ids = await messageRepo.markRead(conversationId, userId, now);
    await conversationRepo.markRead(conversationId, userId, now);
    if (ids.length) emitToUsers(conv.participantIds, CHAT_EVENTS.READ, { conversationId, by: userId, messageIds: ids, at: now });
    return { read: ids.length };
  },

  async markDelivered(userId: string, conversationId: string) {
    const conv = await conversationRepo.findById(conversationId);
    if (!conv) return { delivered: 0 };
    const now = new Date();
    const ids = await messageRepo.markDelivered(conversationId, userId, now);
    if (ids.length) emitToUsers(conv.participantIds, CHAT_EVENTS.DELIVERED, { conversationId, by: userId, messageIds: ids, at: now });
    return { delivered: ids.length };
  },

  async star(userId: string, messageId: string) {
    const m = await messageRepo.findById(messageId);
    if (!m) throw NotFound('Message not found');
    const on = m.starredBy.includes(userId);
    m.starredBy = on ? m.starredBy.filter((u) => u !== userId) : [...m.starredBy, userId];
    await m.save();
    emitToUsers([userId], CHAT_EVENTS.STARRED, { id: String(m._id), starred: !on });
    return { starred: !on };
  },

  async pin(userId: string, messageId: string) {
    const m = await messageRepo.findById(messageId);
    if (!m) throw NotFound('Message not found');
    const conv = await conversationRepo.findById(String(m.conversationId));
    if (!conv) throw NotFound('Conversation not found');
    assertMember(conv, userId);
    m.pinned = !m.pinned;
    m.pinnedBy = m.pinned ? userId : null;
    m.pinnedAt = m.pinned ? new Date() : null;
    await m.save();
    emitToUsers(conv.participantIds, CHAT_EVENTS.PINNED, { id: String(m._id), conversationId: String(m.conversationId), pinned: m.pinned });
    return { pinned: m.pinned };
  },

  async forward(userId: string, messageId: string, toConversationIds: string[]) {
    const src = await messageRepo.findByIdLean(messageId);
    if (!src) throw NotFound('Message not found');
    const results = [];
    for (const cid of toConversationIds) {
      const conv = await conversationRepo.findById(cid);
      if (!conv || !conv.participantIds.includes(userId)) continue;
      const sent = await this.sendMessage(userId, cid, { type: src.type, text: src.text, attachments: src.attachments });
      results.push(sent);
    }
    return results;
  },

  async pinned(userId: string, conversationId: string) {
    const conv = await conversationRepo.findById(conversationId);
    if (!conv) throw NotFound('Conversation not found');
    assertMember(conv, userId);
    return (await messageRepo.pinnedFor(conversationId)).map((m) => toMessageDTO(m, userId));
  },

  async starred(userId: string) {
    return (await messageRepo.starredFor(userId)).map((m) => toMessageDTO(m, userId));
  },

  async search(userId: string, text: string, opts: { senderId?: string } = {}) {
    if (!text?.trim()) return [];
    const convs = await conversationRepo.listForUser(userId);
    const ids = convs.map((c) => String(c._id));
    return (await messageRepo.search(ids, text, opts)).map((m) => toMessageDTO(m, userId));
  },

  // ── groups ──
  async createGroup(userId: string, input: { name: string; memberIds: string[]; description?: string; image?: string }) {
    if (!input.name?.trim()) throw BadRequest('Group name required');
    const participantIds = [...new Set([userId, ...(input.memberIds ?? [])])];
    const me = await crmRepo.getUserById(userId);
    const now = new Date();
    const conv = (await conversationRepo.create({
      type: 'group',
      participantIds,
      members: participantIds.map((uid) => ({ userId: uid, role: uid === userId ? 'admin' : 'member', joinedAt: now, lastReadAt: uid === userId ? now : null, unread: 0, muted: false, archived: false })),
      createdBy: userId,
      tenantId: me?.tenant_id ? String(me.tenant_id) : null,
      name: input.name.trim(),
      description: input.description ?? null,
      image: input.image ?? null,
      lastActivityAt: now,
    })) as unknown as ConversationDoc;
    emitToUsers(participantIds, CHAT_EVENTS.CONVERSATION_NEW, { conversationId: String(conv._id) });
    return this.conversationDTO(conv, userId);
  },

  async updateGroup(userId: string, conversationId: string, patch: { name?: string; description?: string; image?: string }) {
    const conv = await conversationRepo.findById(conversationId);
    if (!conv || conv.type !== 'group') throw NotFound('Group not found');
    await assertManageGroup(conv, userId);
    const set: Record<string, unknown> = {};
    if (patch.name !== undefined) set.name = patch.name;
    if (patch.description !== undefined) set.description = patch.description;
    if (patch.image !== undefined) set.image = patch.image;
    await ConversationModel().updateOne({ _id: conv._id }, { $set: set });
    const updated = await conversationRepo.findById(conversationId);
    emitToUsers(conv.participantIds, CHAT_EVENTS.CONVERSATION_UPDATED, { conversationId });
    return this.conversationDTO(updated as ConversationDoc, userId);
  },

  async addMembers(userId: string, conversationId: string, memberIds: string[]) {
    const conv = await conversationRepo.findById(conversationId);
    if (!conv || conv.type !== 'group') throw NotFound('Group not found');
    await assertManageGroup(conv, userId);
    const toAdd = memberIds.filter((id) => !conv.participantIds.includes(id));
    if (toAdd.length) {
      await ConversationModel().updateOne(
        { _id: conv._id },
        {
          $addToSet: { participantIds: { $each: toAdd } },
          $push: { members: { $each: toAdd.map((uid) => ({ userId: uid, role: 'member', joinedAt: new Date(), lastReadAt: null, unread: 0, muted: false, archived: false })) } },
        },
      );
      emitToUsers([...conv.participantIds, ...toAdd], CHAT_EVENTS.CONVERSATION_UPDATED, { conversationId });
      emitToUsers(toAdd, CHAT_EVENTS.CONVERSATION_NEW, { conversationId });
    }
    const updated = await conversationRepo.findById(conversationId);
    return this.conversationDTO(updated as ConversationDoc, userId);
  },

  async removeMember(userId: string, conversationId: string, memberId: string) {
    const conv = await conversationRepo.findById(conversationId);
    if (!conv || conv.type !== 'group') throw NotFound('Group not found');
    if (memberId !== userId) await assertManageGroup(conv, userId); // leaving is allowed; removing others needs admin
    await ConversationModel().updateOne({ _id: conv._id }, { $pull: { participantIds: memberId, members: { userId: memberId } } });
    emitToUsers(conv.participantIds, CHAT_EVENTS.CONVERSATION_UPDATED, { conversationId });
    return { ok: true };
  },

  async promoteAdmin(userId: string, conversationId: string, memberId: string) {
    const conv = await conversationRepo.findById(conversationId);
    if (!conv || conv.type !== 'group') throw NotFound('Group not found');
    await assertManageGroup(conv, userId);
    await ConversationModel().updateOne({ _id: conv._id, 'members.userId': memberId }, { $set: { 'members.$.role': 'admin' } });
    emitToUsers(conv.participantIds, CHAT_EVENTS.CONVERSATION_UPDATED, { conversationId });
    return { ok: true };
  },

  // membership for socket room joins / typing
  async participantsOf(conversationId: string): Promise<string[]> {
    const conv = await conversationRepo.findById(conversationId);
    return conv?.participantIds ?? [];
  },
  async assertAccess(userId: string, conversationId: string): Promise<ConversationDoc> {
    const conv = await conversationRepo.findById(conversationId);
    if (!conv) throw NotFound('Conversation not found');
    assertMember(conv, userId);
    return conv;
  },
};

// silence unused import if MessageModel only used indirectly
void MessageModel;
