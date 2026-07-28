import { Types } from 'mongoose';
import { Forbidden, NotFound, BadRequest } from '../../common/errors';
import { crmRepo } from '../crm.repo';
import { accessService } from '../access';
import { userAvatars } from '../userAvatars';
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
  CONVERSATION_DELETED: 'chat:conversationDeleted',
} as const;

const EDIT_WINDOW_MS = 15 * 60 * 1000; // 15 min
const DELETE_EVERYONE_WINDOW_MS = 60 * 60 * 1000; // 1 h
const directKeyOf = (a: string, b: string): string => [a, b].sort().join('|');

// ── helpers ──
async function resolveUsers(ids: string[]): Promise<Record<string, { id: string; name: string; email: string; avatar: string | null }>> {
  const valid = [...new Set(ids)].filter((id) => Types.ObjectId.isValid(id)).map((id) => new Types.ObjectId(id));
  const users = await crmRepo.listUsers({ _id: { $in: valid } });
  const avatars = await userAvatars.mapFor(users.map((u) => String(u._id)));
  const map: Record<string, { id: string; name: string; email: string; avatar: string | null }> = {};
  for (const u of users) {
    const name = `${u.first_name ?? ''} ${u.last_name ?? ''}`.trim() || u.email;
    map[String(u._id)] = { id: String(u._id), name, email: u.email, avatar: avatars[String(u._id)] ?? null };
  }
  return map;
}

function assertMember(conv: ConversationDoc, userId: string): void {
  if (!conv.participantIds.includes(userId)) throw Forbidden('Not a participant of this conversation');
}
// Group management is allowed for the creator, any promoted group admin, OR a super-admin
// (so a super-admin can curate any group's membership).
async function canManageGroup(conv: ConversationDoc, userId: string): Promise<boolean> {
  const m = conv.members.find((x) => x.userId === userId);
  if (conv.createdBy === userId || m?.role === 'admin') return true;
  const access = await accessService.accessForUserId(userId);
  return !!access?.isSuper;
}
async function assertManageGroup(conv: ConversationDoc, userId: string): Promise<void> {
  if (!(await canManageGroup(conv, userId))) throw Forbidden('Requires group admin');
}

// Add-only allowlist: these users may ADD people to any group they are a MEMBER of, without being a
// group admin/creator (removing members and renaming need GROUP_EDIT_EMAILS; deleting/promoting
// stays with assertManageGroup). Emails are the source of truth so it survives user-id changes.
const GROUP_ADD_MEMBER_EMAILS = new Set(['faiz@travkings.com', 'pravesh@travkings.com', 'farhan@travkings.com']);

// Edit allowlist: these users may RENAME a group and REMOVE members in any group they are a MEMBER
// of, without being a group admin/creator (deleting the group and promoting admins stays with
// assertManageGroup). Emails are the source of truth so it survives user-id changes. Keep in sync
// with the frontend list in Frontend/app/chat/group-info.tsx (EDIT_GROUP_EMAILS).
const GROUP_EDIT_EMAILS = new Set(['faiz@travkings.com']);

// Rename-only allowlist: may edit the group's name/description/image in groups they are a MEMBER
// of, but NOT remove members. Keep in sync with the frontend list in
// Frontend/app/chat/group-info.tsx (RENAME_GROUP_EMAILS).
const GROUP_RENAME_EMAILS = new Set(['farhan@travkings.com']);

async function assertEditGroup(conv: ConversationDoc, userId: string, action: 'update' | 'removeMember'): Promise<void> {
  if (await canManageGroup(conv, userId)) return;
  if (conv.participantIds.includes(userId)) {
    const user = await crmRepo.getUserById(userId);
    const email = (user?.email ?? '').toLowerCase().trim();
    if (email && GROUP_EDIT_EMAILS.has(email)) return;
    if (email && action === 'update' && GROUP_RENAME_EMAILS.has(email)) return;
  }
  throw Forbidden('Requires group admin');
}

// Group-CREATE allowlist: super-admins may always create groups; in addition these emails are
// delegated group creators (they can create groups without full super rights, and are treated like
// a super for the per-branch create guard so they can create in any branch). Emails are the source
// of truth so it survives user-id changes. Keep in sync with the frontend list in
// Frontend/src/logic/groupCreate.ts.
const GROUP_CREATE_EMAILS = new Set(['farhan@travkings.com', 'faiz@travkings.com']);

// True if the user may create groups: a super-admin, or an allowlisted delegated creator.
export async function canCreateGroup(userId: string): Promise<boolean> {
  const access = await accessService.accessForUserId(userId);
  if (access?.isSuper) return true;
  const user = await crmRepo.getUserById(userId);
  return !!user && GROUP_CREATE_EMAILS.has((user.email ?? '').toLowerCase().trim());
}

async function assertCanAddMembers(conv: ConversationDoc, userId: string): Promise<void> {
  // Full managers (creator / group admin / super-admin) can always add.
  const m = conv.members.find((x) => x.userId === userId);
  if (conv.createdBy === userId || m?.role === 'admin') return;
  const access = await accessService.accessForUserId(userId);
  if (access?.isSuper) return;
  // Otherwise the allowlisted users may add — but only to a group they actually belong to.
  if (conv.participantIds.includes(userId)) {
    const user = await crmRepo.getUserById(userId);
    if (user && GROUP_ADD_MEMBER_EMAILS.has((user.email ?? '').toLowerCase().trim())) return;
  }
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

// ── group system notices (WhatsApp-style "X added Y", "Z left", subject changes) ──
async function displayName(id: string): Promise<string> {
  const map = await resolveUsers([id]);
  return map[id]?.name ?? 'Member';
}
async function displayNames(ids: string[]): Promise<string> {
  const map = await resolveUsers(ids);
  const names = ids.map((id) => map[id]?.name ?? 'Member');
  if (names.length <= 1) return names[0] ?? 'Member';
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}
// Insert a system message into a group's timeline: it renders as a centered notice, becomes the
// chat-list preview, and broadcasts live. Deliberately does NOT bump unread — membership churn
// shouldn't light up the badge. `audience` is the set of user rooms to notify (include a member
// who was just removed so their open app still shows the notice).
async function postSystemMessage(conv: ConversationDoc, actorId: string, text: string, audience: string[]): Promise<void> {
  const now = new Date();
  const created = (await messageRepo.create({
    conversationId: conv._id,
    senderId: actorId,
    type: 'system',
    text,
    status: 'sent',
    sentAt: now,
    deliveredTo: [],
    readBy: [],
  })) as unknown as MessageDoc;
  await ConversationModel().updateOne(
    { _id: conv._id },
    { $set: { lastMessage: { messageId: created._id, text, type: 'system', senderId: actorId, at: now }, lastActivityAt: now } },
  );
  emitToUsers([...new Set(audience)], CHAT_EVENTS.RECEIVE, toMessageBase(created));
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
    const lastStatuses = await this.lastMessageStatuses(convs);
    return convs.map((c) => this.buildConvDTO(c, userId, users, lastStatuses));
  },

  async conversationDTO(conv: ConversationDoc, userId: string) {
    const users = await resolveUsers(conv.participantIds.filter((p) => p !== userId));
    return this.buildConvDTO(conv, userId, users, await this.lastMessageStatuses([conv]));
  },

  // ONE query for the whole list: authoritative status of each conversation's lastMessage
  // (drives the tick on the chat-list row — never fetched per conversation).
  async lastMessageStatuses(convs: ConversationDoc[]): Promise<Record<string, MessageDoc['status']>> {
    const ids = convs.map((c) => c.lastMessage?.messageId).filter((id): id is Types.ObjectId => !!id);
    if (!ids.length) return {};
    const msgs = await MessageModel().find({ _id: { $in: ids } }).select('_id status').lean<Pick<MessageDoc, '_id' | 'status'>[]>();
    return Object.fromEntries(msgs.map((m) => [String(m._id), m.status]));
  },

  buildConvDTO(c: ConversationDoc, userId: string, users: Record<string, { id: string; name: string; avatar?: string | null }>, lastStatuses: Record<string, MessageDoc['status']> = {}) {
    const me = c.members.find((m) => m.userId === userId);
    const lm = c.lastMessage;
    const base = {
      id: String(c._id),
      type: c.type,
      // additive: id + aggregate status alongside the existing {text,type,senderId,at}
      lastMessage: lm ? { ...lm, id: lm.messageId ? String(lm.messageId) : null, status: lm.messageId ? lastStatuses[String(lm.messageId)] ?? null : null } : null,
      unread: me?.unread ?? 0,
      muted: me?.muted ?? false,
      archived: me?.archived ?? false,
      lastActivityAt: c.lastActivityAt,
    };
    if (c.type === 'direct') {
      const otherId = c.participantIds.find((p) => p !== userId) ?? '';
      const other = users[otherId];
      return { ...base, name: other?.name ?? 'Unknown', image: other?.avatar ?? null, otherUserId: otherId, online: isOnline(otherId), lastSeen: getLastSeen(otherId)?.getTime() ?? null, memberCount: 2 };
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
      deptKey: c.deptKey ?? null,
      companyId: c.companyId ?? null, // business this group belongs to
      // branch this group belongs to: explicit field, else derived from the dept key
      branchId: c.branchId ?? (c.deptKey ? c.deptKey.split(':')[0] : null),
      departmentId: c.departmentId ?? (c.deptKey ? c.deptKey.split(':')[1] : null),
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

    // Idempotency: if this clientId was already stored (retry / double-send after a dropped response),
    // return the existing message instead of creating a duplicate.
    if (input.clientId) {
      const existing = await messageRepo.findByClientId(conv._id, input.clientId);
      if (existing) return { ...toMessageDTO(existing, userId), clientId: input.clientId };
    }

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
      clientId: input.clientId ?? null,
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
        await Promise.all(recipients.map((r) => chatPush.notifyNewMessage(r, {
          title,
          body,
          conversationId,
          messageId: String(created._id),
          senderId: userId,
          senderName,
          convType: conv.type,
          convName: conv.name ?? '',
          preview,
          msgType: type,
          sentAt: now.toISOString(),
        })));
      } catch {
        /* push is best-effort */
      }
    })();

    return { ...toMessageDTO(created, userId), clientId: input.clientId }; // echo clientId so the sender reconciles its optimistic row
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
    const { ids, statuses } = await messageRepo.markRead(conversationId, userId, conv.participantIds, now);
    await conversationRepo.markRead(conversationId, userId, now);
    if (ids.length) emitToUsers(conv.participantIds, CHAT_EVENTS.READ, { conversationId, by: userId, messageIds: ids, at: now.getTime(), statuses });
    return { read: ids.length };
  },

  async markDelivered(userId: string, conversationId: string) {
    const conv = await conversationRepo.findById(conversationId);
    if (!conv) throw NotFound('Conversation not found');
    assertMember(conv, userId);
    const now = new Date();
    const { ids, statuses } = await messageRepo.markDelivered(conversationId, userId, conv.participantIds, now);
    if (ids.length) emitToUsers(conv.participantIds, CHAT_EVENTS.DELIVERED, { conversationId, by: userId, messageIds: ids, at: now.getTime(), statuses });
    return { delivered: ids.length };
  },

  // Delivered-on-connect sweep: double-tick everything pending for this user the moment they come
  // online (WhatsApp-style, no chat open needed) — one 'chat:delivered' per affected conversation.
  async markDeliveredEverywhere(userId: string) {
    const convs = await ConversationModel().find({ participantIds: userId }).select('_id participantIds').lean<Pick<ConversationDoc, '_id' | 'participantIds'>[]>();
    if (!convs.length) return { conversations: 0, delivered: 0 };
    const now = new Date();
    const results = await messageRepo.markDeliveredAcross(convs.map((c) => ({ id: String(c._id), participantIds: c.participantIds })), userId, now);
    const rosters = new Map(convs.map((c) => [String(c._id), c.participantIds]));
    for (const r of results) {
      emitToUsers(rosters.get(r.conversationId) ?? [], CHAT_EVENTS.DELIVERED, { conversationId: r.conversationId, by: userId, messageIds: r.ids, at: now.getTime(), statuses: r.statuses });
    }
    return { conversations: results.length, delivered: results.reduce((n, r) => n + r.ids.length, 0) };
  },

  async star(userId: string, messageId: string) {
    const m = await messageRepo.findById(messageId);
    if (!m) throw NotFound('Message not found');
    // Membership gate: only a participant of the message's conversation may star it (otherwise a
    // user could star an arbitrary message id and read its content back via GET /messages/starred).
    const conv = await conversationRepo.findById(String(m.conversationId));
    if (!conv) throw NotFound('Conversation not found');
    assertMember(conv, userId);
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
    // Membership gate on the SOURCE conversation: you can only forward a message you were allowed
    // to see. Without this, a user could forward any message id into their own chat and read its
    // text + attachments (IDOR). Destination membership is checked per-target in the loop below.
    const srcConv = await conversationRepo.findById(String(src.conversationId));
    if (!srcConv || !srcConv.participantIds.includes(userId)) throw NotFound('Message not found');
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
  async createGroup(userId: string, input: { name: string; memberIds: string[]; description?: string; image?: string; companyId?: string; branchId?: string; departmentId?: string }) {
    if (!input.name?.trim()) throw BadRequest('Group name required');
    let companyId = input.companyId?.trim() || null;
    const branchId = input.branchId?.trim() || null;
    const departmentId = input.departmentId?.trim() || null;
    // Access guard: only super-admins / company-wide roles may create a group in a branch they don't
    // belong to (the New Group picker is access-scoped, but enforce it server-side too).
    if (branchId) {
      const access = await accessService.accessForUserId(userId);
      // Delegated group creators (GROUP_CREATE_EMAILS) are treated like a super here so they can
      // create a group in any branch, not just their own.
      const allowed = (await canCreateGroup(userId)) || (!!access && (access.companyWide || (access.branchIds ?? []).includes(branchId)));
      if (!allowed) throw Forbidden('You can only create groups in your own branch');
      // Anchor the group to its business: the branch's company must match the selected one
      // (or fills it in when omitted), so a group always lives under business → branch → department.
      if (Types.ObjectId.isValid(branchId)) {
        const branch = (await crmRepo.branchesByIds([new Types.ObjectId(branchId)]))[0];
        const branchCompanyId = branch?.company_id ? String(branch.company_id) : null;
        if (companyId && branchCompanyId && companyId !== branchCompanyId) throw BadRequest('Branch does not belong to the selected business');
        companyId = branchCompanyId ?? companyId;
      }
    }
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
      companyId, // business this group belongs to (validated/derived from the branch above)
      branchId, // branch this group belongs to
      departmentId, // department this group belongs to (branch → department → many groups)
      deptKey: branchId && departmentId ? `${branchId}:${departmentId}` : null, // non-unique lookup key
      lastActivityAt: now,
    })) as unknown as ConversationDoc;
    emitToUsers(participantIds, CHAT_EVENTS.CONVERSATION_NEW, { conversationId: String(conv._id) });
    return this.conversationDTO(conv, userId);
  },

  // Get-or-create the AUTO group chat for a (branch, department). Members = everyone in that branch
  // (CRM branch_ids). Only a branch member or a super-admin may open/create it. Idempotent via deptKey.
  async getOrCreateDepartmentGroup(userId: string, input: { branchId: string; departmentId: string; name: string }) {
    const { branchId, departmentId } = input;
    if (!Types.ObjectId.isValid(branchId)) throw BadRequest('Invalid branch');
    const deptKey = `${branchId}:${departmentId}`;
    const access = await accessService.accessForUserId(userId);
    const isSuper = !!access?.isSuper;

    const branchUsers = await crmRepo.listUsers({ branch_ids: new Types.ObjectId(branchId) });
    const branchMemberIds = branchUsers.map((u) => String(u._id));
    if (!isSuper && !branchMemberIds.includes(userId)) throw Forbidden('You are not in this branch');

    const existing = await conversationRepo.findByDeptKey(deptKey);
    if (existing) {
      // Ensure the opener is a participant (new branch member / super-admin opening it).
      if (!existing.participantIds.includes(userId)) {
        await ConversationModel().updateOne(
          { _id: existing._id },
          {
            $addToSet: { participantIds: userId },
            $push: { members: { userId, role: isSuper ? 'admin' : 'member', joinedAt: new Date(), lastReadAt: null, unread: 0, muted: false, archived: false } },
          },
        );
        const refreshed = await conversationRepo.findById(String(existing._id));
        return this.conversationDTO(refreshed as ConversationDoc, userId);
      }
      return this.conversationDTO(existing, userId);
    }

    const participantIds = [...new Set([userId, ...branchMemberIds])];
    const me = await crmRepo.getUserById(userId);
    const branch = (await crmRepo.branchesByIds([new Types.ObjectId(branchId)]))[0];
    const now = new Date();
    const conv = (await conversationRepo.create({
      type: 'group',
      participantIds,
      members: participantIds.map((uid) => ({ userId: uid, role: uid === userId ? 'admin' : 'member', joinedAt: now, lastReadAt: uid === userId ? now : null, unread: 0, muted: false, archived: false })),
      createdBy: userId,
      tenantId: me?.tenant_id ? String(me.tenant_id) : null,
      name: input.name?.trim() || 'Group',
      companyId: branch?.company_id ? String(branch.company_id) : null, // business, derived from the branch
      deptKey,
      lastActivityAt: now,
    })) as unknown as ConversationDoc;
    emitToUsers(participantIds, CHAT_EVENTS.CONVERSATION_NEW, { conversationId: String(conv._id) });
    return this.conversationDTO(conv, userId);
  },

  async updateGroup(userId: string, conversationId: string, patch: { name?: string; description?: string; image?: string }) {
    const conv = await conversationRepo.findById(conversationId);
    if (!conv || conv.type !== 'group') throw NotFound('Group not found');
    await assertEditGroup(conv, userId, 'update');
    const set: Record<string, unknown> = {};
    if (patch.name !== undefined) set.name = patch.name;
    if (patch.description !== undefined) set.description = patch.description;
    if (patch.image !== undefined) set.image = patch.image;
    await ConversationModel().updateOne({ _id: conv._id }, { $set: set });
    const updated = await conversationRepo.findById(conversationId);
    emitToUsers(conv.participantIds, CHAT_EVENTS.CONVERSATION_UPDATED, { conversationId });
    if (patch.name !== undefined && patch.name.trim() && patch.name !== conv.name) {
      await postSystemMessage(conv, userId, `${await displayName(userId)} changed the group name to "${patch.name.trim()}"`, conv.participantIds);
    }
    return this.conversationDTO(updated as ConversationDoc, userId);
  },

  async addMembers(userId: string, conversationId: string, memberIds: string[]) {
    const conv = await conversationRepo.findById(conversationId);
    if (!conv || conv.type !== 'group') throw NotFound('Group not found');
    await assertCanAddMembers(conv, userId);
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
      await postSystemMessage(conv, userId, `${await displayName(userId)} added ${await displayNames(toAdd)}`, [...conv.participantIds, ...toAdd]);
    }
    const updated = await conversationRepo.findById(conversationId);
    return this.conversationDTO(updated as ConversationDoc, userId);
  },

  async removeMember(userId: string, conversationId: string, memberId: string) {
    const conv = await conversationRepo.findById(conversationId);
    if (!conv || conv.type !== 'group') throw NotFound('Group not found');
    if (memberId !== userId) await assertEditGroup(conv, userId, 'removeMember'); // leaving is allowed; removing others needs admin or the edit allowlist
    const wasMember = conv.participantIds.includes(memberId);
    await ConversationModel().updateOne({ _id: conv._id }, { $pull: { participantIds: memberId, members: { userId: memberId } } });
    emitToUsers(conv.participantIds, CHAT_EVENTS.CONVERSATION_UPDATED, { conversationId });
    if (wasMember) {
      const text = memberId === userId ? `${await displayName(userId)} left` : `${await displayName(userId)} removed ${await displayName(memberId)}`;
      await postSystemMessage(conv, userId, text, conv.participantIds); // conv.participantIds still includes the removed member → they see the notice
    }
    return { ok: true };
  },

  // Delete a group entirely (admins/creator/super) — removes the conversation and all its messages,
  // and tells every (former) member to drop it from their list.
  async deleteGroup(userId: string, conversationId: string) {
    const conv = await conversationRepo.findById(conversationId);
    if (!conv || conv.type !== 'group') throw NotFound('Group not found');
    await assertManageGroup(conv, userId);
    const participantIds = [...conv.participantIds];
    await MessageModel().deleteMany({ conversationId: conv._id });
    await ConversationModel().deleteOne({ _id: conv._id });
    emitToUsers(participantIds, CHAT_EVENTS.CONVERSATION_DELETED, { conversationId });
    return { ok: true };
  },

  async promoteAdmin(userId: string, conversationId: string, memberId: string) {
    const conv = await conversationRepo.findById(conversationId);
    if (!conv || conv.type !== 'group') throw NotFound('Group not found');
    await assertManageGroup(conv, userId);
    const alreadyAdmin = conv.members.find((m) => m.userId === memberId)?.role === 'admin';
    await ConversationModel().updateOne({ _id: conv._id, 'members.userId': memberId }, { $set: { 'members.$.role': 'admin' } });
    emitToUsers(conv.participantIds, CHAT_EVENTS.CONVERSATION_UPDATED, { conversationId });
    if (!alreadyAdmin) await postSystemMessage(conv, userId, `${await displayName(memberId)} is now an admin`, conv.participantIds);
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
