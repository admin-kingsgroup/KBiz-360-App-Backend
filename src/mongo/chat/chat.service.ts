import { Types } from 'mongoose';
import { AppError, Forbidden, NotFound, BadRequest } from '../../common/errors';
import { crmRepo } from '../crm.repo';
import { accessService } from '../access';
import { userAvatars } from '../userAvatars';
import { ConversationModel, MessageModel, type ConvMember, type ConversationDoc, type MessageDoc, type Attachment } from './chat.models';
import { chatSettingsRepo, conversationRepo, messageRepo } from './chat.repository';
import { emitToUsers, isOnline, getLastSeen } from './chat.events';
import { chatPush } from './chat.push';
import { stripFormatting } from './formatting';
import { TaskModel } from '../tasks/task.model';
import { taskNotify } from '../tasks/task.notify';

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
// What the chat-list preview reads once a message is deleted for everyone.
const DELETED_PREVIEW = 'This message was deleted';
const directKeyOf = (a: string, b: string): string => [a, b].sort().join('|');

// Task chats (spec §6): at most one push per chat per person every 5 minutes, so a burst of messages
// in a task's chat buzzes once. An @mention always gets through. In-memory: a restart only resets it.
export const TASK_CHAT_PUSH_GAP_MS = 5 * 60 * 1000;
const lastTaskChatPush = new Map<string, number>();
export function taskChatPushAllowed(conversationId: string, userId: string, mentioned: boolean, now = Date.now()): boolean {
  const key = `${conversationId}:${userId}`;
  const last = lastTaskChatPush.get(key) ?? 0;
  if (!mentioned && now - last < TASK_CHAT_PUSH_GAP_MS) return false;
  lastTaskChatPush.set(key, now);
  if (lastTaskChatPush.size > 20_000) lastTaskChatPush.clear(); // bounded; worst case one extra push
  return true;
}

// "24 hours" / "7 days" / "90 days" for the system notice a disappearing-messages change posts.
function humanDuration(seconds: number): string {
  const day = 86400;
  if (seconds % day === 0) { const d = seconds / day; return `${d} day${d === 1 ? '' : 's'}`; }
  const h = Math.round(seconds / 3600);
  if (h >= 1) return `${h} hour${h === 1 ? '' : 's'}`;
  const m = Math.round(seconds / 60);
  return `${m} minute${m === 1 ? '' : 's'}`;
}

// Blocking is symmetric in effect: whichever side pressed the button, neither can reach the other.
async function isBlockedBetween(a: string, b: string): Promise<boolean> {
  const [mine, theirs] = await Promise.all([chatSettingsRepo.get(a), chatSettingsRepo.get(b)]);
  return mine.blocked.includes(b) || theirs.blocked.includes(a);
}

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
    mentions: deleted ? [] : (m.mentions ?? []), // pre-mentions docs lack the field
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

// "Delete chat": nothing has been said in the chat since this member deleted it, so it stays off their
// list. The first message after the deletion (from either side) brings it back, empty before that.
function clearedFor(c: ConversationDoc, userId: string): Date | null {
  const at = c.members.find((m) => m.userId === userId)?.clearedAt;
  return at ? new Date(at) : null;
}
// A closed / cancelled task's chat: off every chat list, read-only (readable from the task).
function isClosedTaskChat(c: ConversationDoc): boolean {
  return c.type === 'task' && !!c.closedAt;
}
function hiddenFor(c: ConversationDoc, userId: string): boolean {
  const cleared = clearedFor(c, userId);
  if (!cleared) return false;
  const last = c.lastMessage?.at ? new Date(c.lastMessage.at) : null;
  return !last || last.getTime() <= cleared.getTime();
}

const SERVICE_MEDIA_LABEL: Record<string, string> = { image: '📷 Photo', video: '🎥 Video', document: '📄 Document', voice: '🎤 Voice message' };

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
          { userId, role: 'member', joinedAt: new Date(), lastReadAt: new Date(), unread: 0, muted: false, mutedUntil: null, archived: false, pinned: false },
          { userId: otherUserId, role: 'member', joinedAt: new Date(), lastReadAt: null, unread: 0, muted: false, mutedUntil: null, archived: false, pinned: false },
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
    const convs = (await conversationRepo.listForUser(userId)).filter((c) => !hiddenFor(c, userId) && !isClosedTaskChat(c));
    const otherIds = convs.flatMap((c) => c.participantIds.filter((p) => p !== userId));
    const users = await resolveUsers(otherIds);
    const lastStatuses = await this.lastMessageStatuses(convs);
    const taskStatuses = await this.taskStatuses(convs);
    return convs.map((c) => this.buildConvDTO(c, userId, users, lastStatuses, taskStatuses));
  },

  async conversationDTO(conv: ConversationDoc, userId: string) {
    const users = await resolveUsers(conv.participantIds.filter((p) => p !== userId));
    return this.buildConvDTO(conv, userId, users, await this.lastMessageStatuses([conv]), await this.taskStatuses([conv]));
  },

  // ONE query for the whole list: authoritative status of each conversation's lastMessage
  // (drives the tick on the chat-list row — never fetched per conversation).
  async lastMessageStatuses(convs: ConversationDoc[]): Promise<Record<string, MessageDoc['status']>> {
    const ids = convs.map((c) => c.lastMessage?.messageId).filter((id): id is Types.ObjectId => !!id);
    if (!ids.length) return {};
    const msgs = await MessageModel().find({ _id: { $in: ids } }).select('_id status').lean<Pick<MessageDoc, '_id' | 'status'>[]>();
    return Object.fromEntries(msgs.map((m) => [String(m._id), m.status]));
  },

  // Task chats carry their task's status, so the chat list can file closed / cancelled ones under
  // "Closed task chats" without fetching the tasks (ONE query for the whole list).
  async taskStatuses(convs: ConversationDoc[]): Promise<Record<string, string>> {
    const ids = convs.filter((c) => c.type === 'task' && c.taskId && Types.ObjectId.isValid(c.taskId)).map((c) => new Types.ObjectId(c.taskId as string));
    if (!ids.length) return {};
    const rows = await TaskModel().find({ _id: { $in: ids } }).select('_id status').lean<{ _id: Types.ObjectId; status: string }[]>();
    return Object.fromEntries(rows.map((t) => [String(t._id), t.status]));
  },

  buildConvDTO(c: ConversationDoc, userId: string, users: Record<string, { id: string; name: string; avatar?: string | null }>, lastStatuses: Record<string, MessageDoc['status']> = {}, taskStatuses: Record<string, string> = {}) {
    const me = c.members.find((m) => m.userId === userId);
    // A last message from before this member deleted the chat is not theirs to preview any more.
    const lm = hiddenFor(c, userId) ? null : c.lastMessage;
    const base = {
      id: String(c._id),
      type: c.type,
      // additive: id + aggregate status alongside the existing {text,type,senderId,at}
      lastMessage: lm ? { ...lm, id: lm.messageId ? String(lm.messageId) : null, status: lm.messageId ? lastStatuses[String(lm.messageId)] ?? null : null } : null,
      unread: me?.unread ?? 0,
      // A timed mute reports itself as OFF once it lapses, so the client never has to know the rule.
      muted: !!me?.muted && (!me.mutedUntil || me.mutedUntil.getTime() > Date.now()),
      mutedUntil: me?.mutedUntil ? me.mutedUntil.toISOString() : null,
      archived: me?.archived ?? false,
      pinned: me?.pinned ?? false,
      // When this member last deleted the chat — a second device of theirs drops what it stored before it.
      clearedAt: me?.clearedAt ? new Date(me.clearedAt).toISOString() : null,
      disappearAfterSec: c.disappearAfterSec ?? null,
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
      companyId: c.companyId ?? null, // business this group belongs to
      branchId: c.branchId ?? null, // branch this group belongs to
      ...(c.type === 'task' ? { taskId: c.taskId ?? null, taskStatus: c.taskId ? taskStatuses[c.taskId] ?? null : null, closed: !!c.closedAt } : {}),
    };
  },

  // ── messages ──
  async getMessages(userId: string, conversationId: string, page: { before?: string; after?: string; limit?: number }) {
    const conv = await conversationRepo.findById(conversationId);
    if (!conv) throw NotFound('Conversation not found');
    assertMember(conv, userId);
    const msgs = await messageRepo.listByConversation(conversationId, userId, page);
    return msgs.map((m) => toMessageDTO(m, userId));
  },

  // ── per-chat settings (mute / archive / pin) ──
  // Personal to the caller: muting or archiving a group changes nothing for anyone else in it.
  async setConversationSettings(userId: string, conversationId: string, patch: { muted?: boolean; muteHours?: number | null; archived?: boolean; pinned?: boolean }) {
    const conv = await conversationRepo.findById(conversationId);
    if (!conv) throw NotFound('Conversation not found');
    assertMember(conv, userId);
    const set: Partial<Pick<ConvMember, 'muted' | 'mutedUntil' | 'archived' | 'pinned'>> = {};
    if (patch.muted !== undefined) {
      set.muted = patch.muted;
      // muteHours null/absent with muted=true ⇒ "Always" (no expiry). Unmuting clears any timer.
      set.mutedUntil = patch.muted && patch.muteHours ? new Date(Date.now() + patch.muteHours * 3600_000) : null;
    }
    if (patch.archived !== undefined) set.archived = patch.archived;
    if (patch.pinned !== undefined) set.pinned = patch.pinned;
    await conversationRepo.setMemberSettings(conversationId, userId, set);
    const fresh = await conversationRepo.findById(conversationId);
    return this.conversationDTO(fresh!, userId);
  },

  // ── delete chat (owner, 2026-11-03: "give option to delete the chat in kbiz app") ──
  // WhatsApp's "Delete chat" for a one-to-one chat: it goes from the caller's list with every message
  // in it, on all their devices. The other person keeps the chat and every message. Nothing is erased
  // from the server — each message is marked deleted-for-the-caller, like a one-message "Delete for
  // me". A later message (from either side) brings the chat back with only what came after.
  // Groups are not deleted this way: a member leaves the group, an admin deletes it for everyone.
  async deleteChat(userId: string, conversationId: string) {
    const conv = await conversationRepo.findById(conversationId);
    if (!conv) throw NotFound('Conversation not found');
    assertMember(conv, userId);
    if (conv.type === 'task') throw BadRequest('A task chat stays with its task — it cannot be deleted');
    if (conv.type !== 'direct') throw BadRequest('A group cannot be deleted as a chat — leave the group, or delete it for everyone as its admin');
    const now = new Date();
    await messageRepo.hideAllFor(conv._id, userId, now);
    // Unread, pin and archive go with the chat; mute stays (it is about the person, and WhatsApp keeps it too).
    // Not marked read: the other side's ticks must not turn blue because a chat was deleted.
    await conversationRepo.setMemberSettings(conversationId, userId, { clearedAt: now, unread: 0, pinned: false, archived: false });
    // My other devices drop the chat (the socket handler forgets it and its stored messages).
    emitToUsers([userId], CHAT_EVENTS.CONVERSATION_DELETED, { conversationId });
    return { ok: true, clearedAt: now.toISOString() };
  },

  // ── disappearing messages ──
  // A property of the chat: switching it on affects everyone, and (like WhatsApp) only messages sent
  // AFTER the change expire — turning it on never deletes history that was sent in the open.
  async setDisappearing(userId: string, conversationId: string, seconds: number | null) {
    const conv = await conversationRepo.findById(conversationId);
    if (!conv) throw NotFound('Conversation not found');
    assertMember(conv, userId);
    if (conv.type === 'task') throw BadRequest('Task chats are kept for the record — messages cannot disappear');
    if (conv.type === 'group') await assertManageGroup(conv, userId); // groups: admins decide
    if (seconds !== null && (!Number.isFinite(seconds) || seconds < 60 || seconds > 90 * 86400)) {
      throw BadRequest('Duration must be between 1 minute and 90 days');
    }
    await conversationRepo.setDisappearing(conversationId, seconds);
    await postSystemMessage(conv, userId, seconds === null
      ? `${await displayName(userId)} turned off disappearing messages`
      : `${await displayName(userId)} set messages to disappear after ${humanDuration(seconds)}`, conv.participantIds);
    emitToUsers(conv.participantIds, CHAT_EVENTS.CONVERSATION_UPDATED, { conversationId });
    return { disappearAfterSec: seconds };
  },

  // ── privacy + blocking ──
  getPrivacy: (userId: string) => chatSettingsRepo.get(userId),
  updatePrivacy: (userId: string, patch: { readReceipts?: boolean; lastSeen?: 'everyone' | 'nobody' }) =>
    chatSettingsRepo.update(userId, patch),

  async setBlocked(userId: string, otherUserId: string, blocked: boolean) {
    if (userId === otherUserId) throw BadRequest('You cannot block yourself');
    // An older app build shows "Block" on a task chat (it reads one as a 1:1 chat) and sends an empty id.
    if (!otherUserId || !Types.ObjectId.isValid(otherUserId)) throw BadRequest('Pick a person to block');
    const settings = await chatSettingsRepo.setBlocked(userId, otherUserId, blocked);
    // Both sides re-read presence/permissions immediately (the blocked user is not told why).
    emitToUsers([userId], CHAT_EVENTS.CONVERSATION_UPDATED, { conversationId: null });
    return settings;
  },

  // Catch-up sync for local-first clients. One call covers EVERY conversation the user is in and
  // returns whatever changed since their watermark — new messages plus edits, deletions, reactions
  // and receipt ticks. The app runs this once when its socket connects; after that the socket keeps
  // it live, so opening a chat needs no request at all.
  //
  // The watermark comes back as a PAIR (`until` + `untilId`) taken from the last row returned, never
  // from the clock — see changedSince for why the id half matters. Clients send both back.
  async syncSince(userId: string, since: Date, sinceId: string | undefined, limit = 200) {
    const convs = (await conversationRepo.listForUser(userId)).filter((c) => !isClosedTaskChat(c));
    const ids = convs.map((c) => c._id);
    const docs = await messageRepo.changedSince(ids, userId, since, sinceId, limit);
    const last = docs.length ? docs[docs.length - 1] : null;
    return {
      messages: docs.map((m) => toMessageDTO(m, userId)),
      until: (last ? new Date(last.updatedAt) : since).toISOString(),
      untilId: last ? String(last._id) : (sinceId ?? null),
      // A full page means there is probably more behind it — the client pages until this is false.
      more: docs.length >= limit,
    };
  },

  // `forwardedFrom` is internal-only (set by forward(), never in the REST schema — zod strips it).
  async sendMessage(userId: string, conversationId: string, input: { type?: MessageDoc['type']; text?: string; attachments?: Attachment[]; replyToId?: string; clientId?: string; mentions?: string[]; forwardedFrom?: MessageDoc['forwardedFrom'] }) {
    const conv = await conversationRepo.findById(conversationId);
    if (!conv) throw NotFound('Conversation not found');
    assertMember(conv, userId);
    if (isClosedTaskChat(conv)) throw new AppError(423, 'This task is closed — its chat is read-only', 'TASK_CLOSED');
    // Blocking (direct chats): refused in BOTH directions — you cannot message someone you blocked,
    // and you cannot message someone who blocked you. The sender is not told which case applies.
    if (conv.type === 'direct') {
      const other = conv.participantIds.find((p) => p !== userId);
      if (other && await isBlockedBetween(userId, other)) throw Forbidden('This message could not be sent');
    }

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

    // Mentions: only actual participants count (a stale/forged id must never trigger a push).
    const mentions = [...new Set(input.mentions ?? [])].filter((id) => conv.participantIds.includes(id));

    const now = new Date();
    const created = (await messageRepo.create({
      conversationId: conv._id,
      senderId: userId,
      type,
      text: input.text ?? '',
      clientId: input.clientId ?? null,
      attachments: input.attachments ?? [],
      replyTo,
      forwardedFrom: input.forwardedFrom ?? null,
      mentions,
      status: 'sent',
      sentAt: now,
      // Disappearing messages: only what is sent while the setting is ON gets an expiry, so switching
      // it on never retro-deletes history (WhatsApp's rule). Mongo's TTL monitor does the deleting.
      expiresAt: conv.disappearAfterSec ? new Date(now.getTime() + conv.disappearAfterSec * 1000) : null,
      deliveredTo: [userId],
      readBy: [],
    })) as unknown as MessageDoc;

    const MEDIA_LABEL: Record<string, string> = { image: '📷 Photo', video: '🎥 Video', document: '📄 Document', voice: '🎤 Voice message' };
    const preview = type === 'text' ? created.text.slice(0, 140) : (MEDIA_LABEL[type] ?? `[${type}]`);
    const pushPreview = type === 'text' ? stripFormatting(created.text).slice(0, 140) : preview; // the notification line shows words, not *markers*
    await conversationRepo.touchLastMessage(conversationId, { messageId: created._id, text: preview, type, senderId: userId, at: now }, userId);

    const base = { ...toMessageBase(created), clientId: input.clientId };
    emitToUsers(conv.participantIds, CHAT_EVENTS.RECEIVE, base);

    // Push ALL recipients (best-effort, non-blocking). We deliberately do NOT gate on socket
    // presence: a backgrounded/killed app can stay "online" on the server until its ping times out
    // (~tens of seconds), so gating dropped pushes. Instead we always push, and the CLIENT suppresses
    // the banner only for the conversation it's actively viewing (foreground handler).
    void (async () => {
      try {
        // Never push to someone who has blocked the sender (they must not even be notified), and
        // never to a recipient whose mute is still running.
        const blockers = new Set(await chatSettingsRepo.blockedBy(userId));
        const candidates = conv.participantIds.filter((p) => p !== userId && !blockers.has(p));
        let recipients = (await Promise.all(candidates.map(async (r) => (await conversationRepo.isMuted(conv._id, r) ? null : r)))).filter((r): r is string => !!r);
        if (conv.type === 'task') {
          recipients = recipients.filter((r) => taskChatPushAllowed(conversationId, r, mentions.includes(r)));
          // An @mention in a task chat is a task event too: the in-app list and an email (spec §6).
          const mentioned = mentions.filter((m) => m !== userId);
          if (mentioned.length && conv.taskId) {
            const task = await TaskModel().findById(conv.taskId).lean();
            if (task) await taskNotify.sendInboxAndEmail('mention', task, mentioned, { actorId: userId, preview: pushPreview });
          }
        }
        // eslint-disable-next-line no-console
        console.log(`[chat-push] msg type=${type} conv=${conversationId} recipients=${recipients.length}`);
        if (!recipients.length) return;
        const sender = await crmRepo.getUserById(userId);
        const senderName = sender ? `${sender.first_name ?? ''} ${sender.last_name ?? ''}`.trim() || sender.email : 'New message';
        const title = conv.type === 'direct' ? senderName : (conv.name ?? (conv.type === 'task' ? 'Task' : 'Group'));
        const body = conv.type === 'direct' ? pushPreview : `${senderName}: ${pushPreview}`;
        await Promise.all(recipients.map(async (r) => chatPush.notifyNewMessage(r, {
          title,
          body: mentions.includes(r) ? `${senderName} mentioned you: ${pushPreview}` : body,
          mention: mentions.includes(r),
          // Counted AFTER touchLastMessage bumped this recipient's unread, so the APNs badge
          // already includes this message. iOS-only consumer; Android recounts client-side.
          badge: await conversationRepo.unreadChatCount(r),
          conversationId,
          messageId: String(created._id),
          senderId: userId,
          senderName,
          convType: conv.type,
          convName: conv.name ?? '',
          preview: pushPreview,
          msgType: type,
          sentAt: now.toISOString(),
          // The message itself — lets the recipient's phone store it on arrival, so it is already
          // on the device (not one fetch away) when they open the chat.
          fullText: created.text,
          attachments: created.attachments,
        })));
      } catch {
        /* push is best-effort */
      }
    })();

    return { ...toMessageDTO(created, userId), clientId: input.clientId }; // echo clientId so the sender reconciles its optimistic row
  },

  // ── Service-posted message (a backend posting into a group, no acting user) ──────────────
  // The ERP's daily finance reports (Receivables / Payables ageing, Bank & Cash) used to land in
  // the mobile Alert channels; they now land in the branch Finance groups as ordinary chat
  // messages, posted through POST /api/alerts/chat by a backend holding the service token.
  //
  // There is no user session behind such a post, so this deliberately skips the membership and
  // blocking checks sendMessage runs: the reporting identity is not a member of the group it
  // reports into, and enrolling it in five groups purely to satisfy an assert would put a bot in
  // every member list and every "who's in this group" screen. Everything AFTER those checks is
  // identical to a human send — stored message, conversation preview + unread bump, socket
  // fan-out, push to everyone who has not muted the group.
  //
  // `clientId` is the idempotency key, exactly as a phone's optimistic id is: the scheduler
  // passes "<kind>-<branch>-<date>", so a cron catch-up, a retry after a timeout, or a second
  // process firing the same slot re-posts nothing (it returns the existing message).
  //
  // `mediaType` (2026-10-12, the "Ticket Support" group): a post carrying a screenshot, a voice note
  // or a screen recording is stored as that kind of message, so the phone shows a photo, a player
  // or a video tile instead of a file card. Without it an attachment is a document, as before.
  /** The id of the service post already stored under this idempotency key, or null. Lets a media
   *  post skip storing the file again on a retry, before postServiceMessage's own check would. */
  async findServiceMessageId(conversationId: string, clientId: string): Promise<string | null> {
    if (!Types.ObjectId.isValid(conversationId)) return null;
    const existing = await messageRepo.findByClientId(new Types.ObjectId(conversationId), clientId);
    return existing ? String(existing._id) : null;
  },

  // `preview` replaces the chat-list / notification line a media message would otherwise get from
  // its type ("📄 Document") — a ticket bundle reads better as its own title.
  async postServiceMessage(conversationId: string, senderId: string, input: { text: string; attachments?: Attachment[]; mediaType?: 'image' | 'video' | 'voice' | 'document'; clientId?: string; senderName?: string; preview?: string }) {
    const conv = await conversationRepo.findById(conversationId);
    if (!conv) throw NotFound('Conversation not found');
    if (input.clientId) {
      const existing = await messageRepo.findByClientId(conv._id, input.clientId);
      if (existing) return { ...toMessageBase(existing), duplicate: true };
    }
    const type: MessageDoc['type'] = input.attachments?.length ? (input.mediaType ?? 'document') : 'text';
    if (type === 'text' && !input.text.trim()) throw BadRequest('Empty message');

    const now = new Date();
    const created = (await messageRepo.create({
      conversationId: conv._id,
      senderId,
      type,
      text: input.text ?? '',
      clientId: input.clientId ?? null,
      attachments: input.attachments ?? [],
      replyTo: null,
      forwardedFrom: null,
      mentions: [],
      status: 'sent',
      sentAt: now,
      expiresAt: conv.disappearAfterSec ? new Date(now.getTime() + conv.disappearAfterSec * 1000) : null,
      deliveredTo: [senderId],
      readBy: [],
    })) as unknown as MessageDoc;

    const preview = input.preview?.trim() ? input.preview.trim().slice(0, 140)
      : type === 'text' ? created.text.slice(0, 140) : (SERVICE_MEDIA_LABEL[type] ?? '📄 Document');
    const pushPreview = type === 'text' ? stripFormatting(created.text).slice(0, 140) : preview; // the notification line shows words, not *markers*
    await conversationRepo.touchLastMessage(conversationId, { messageId: created._id, text: preview, type, senderId, at: now }, senderId);
    emitToUsers(conv.participantIds, CHAT_EVENTS.RECEIVE, toMessageBase(created));

    void (async () => {
      try {
        const recipients = (await Promise.all(conv.participantIds
          .filter((p) => p !== senderId)
          .map(async (r) => (await conversationRepo.isMuted(conv._id, r) ? null : r))))
          .filter((r): r is string => !!r);
        // eslint-disable-next-line no-console
        console.log(`[chat-push] service msg type=${type} conv=${conversationId} recipients=${recipients.length}`);
        if (!recipients.length) return;
        const senderName = input.senderName ?? await displayName(senderId);
        await Promise.all(recipients.map(async (r) => chatPush.notifyNewMessage(r, {
          title: conv.name ?? 'Group',
          body: `${senderName}: ${pushPreview}`,
          badge: await conversationRepo.unreadChatCount(r),
          conversationId,
          messageId: String(created._id),
          senderId,
          senderName,
          convType: conv.type,
          convName: conv.name ?? '',
          preview: pushPreview,
          msgType: type,
          sentAt: now.toISOString(),
          fullText: created.text,
          attachments: created.attachments,
        })));
      } catch {
        /* push is best-effort */
      }
    })();

    return { ...toMessageBase(created), duplicate: false };
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
    await conversationRepo.tombstoneLastMessage(m.conversationId, m._id, DELETED_PREVIEW);
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
    // Read receipts off ⇒ the blue tick is never broadcast. The read itself is still recorded (it
    // clears YOUR unread badge); only the telling of it is suppressed. Groups are exempt, exactly as
    // in WhatsApp, where the setting cannot hide reads in a group.
    const tell = conv.type !== 'direct' || await chatSettingsRepo.readReceiptsEnabled(userId);
    if (ids.length && tell) emitToUsers(conv.participantIds, CHAT_EVENTS.READ, { conversationId, by: userId, messageIds: ids, at: now.getTime(), statuses });
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

  // Per-user receipts for one message ("message info"). Sender-only, like
  // WhatsApp — other participants never see who read whose messages.
  async receipts(userId: string, messageId: string) {
    const m = await messageRepo.findById(messageId);
    if (!m || m.senderId !== userId) throw NotFound('Message not found'); // don't leak existence to non-senders
    const conv = await conversationRepo.findById(String(m.conversationId));
    if (!conv) throw NotFound('Conversation not found');
    assertMember(conv, userId);
    const readBy = (m.readBy ?? [])
      .filter((r) => r.userId !== userId)
      .map((r) => ({ userId: r.userId, at: r.at ? r.at.getTime() : null }));
    const readSet = new Set(readBy.map((r) => r.userId));
    const deliveredTo = (m.deliveredTo ?? []).filter((u) => u !== userId && !readSet.has(u));
    return { readBy, deliveredTo, participants: conv.participantIds.filter((u) => u !== userId) };
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
      // Keep the ORIGINAL origin on a re-forward (WhatsApp-style: the label survives forward chains).
      // Mentions are deliberately NOT carried — the "@Name" text stays but nobody is re-notified.
      const sent = await this.sendMessage(userId, cid, {
        type: src.type,
        text: src.text,
        attachments: src.attachments,
        forwardedFrom: src.forwardedFrom ?? { messageId: src._id, conversationId: src.conversationId },
      });
      results.push(sent);
    }
    return results;
  },

  async pinned(userId: string, conversationId: string) {
    const conv = await conversationRepo.findById(conversationId);
    if (!conv) throw NotFound('Conversation not found');
    assertMember(conv, userId);
    return (await messageRepo.pinnedFor(conversationId, userId)).map((m) => toMessageDTO(m, userId));
  },

  async starred(userId: string) {
    return (await messageRepo.starredFor(userId)).map((m) => toMessageDTO(m, userId));
  },

  // Global (all my conversations) or scoped to one conversation when `conversationId` is given —
  // the in-chat "Search in chat" surface. `before` pages older results (id cursor, newest-first).
  async search(userId: string, text: string, opts: { senderId?: string; conversationId?: string; before?: string } = {}) {
    if (!text?.trim()) return [];
    let ids: string[];
    if (opts.conversationId) {
      const conv = await conversationRepo.findById(opts.conversationId);
      if (!conv) throw NotFound('Conversation not found');
      assertMember(conv, userId);
      ids = [opts.conversationId];
    } else {
      const convs = await conversationRepo.listForUser(userId);
      ids = convs.map((c) => String(c._id));
    }
    return (await messageRepo.search(ids, userId, text.trim(), opts)).map((m) => toMessageDTO(m, userId));
  },

  // ── groups ──
  async createGroup(userId: string, input: { name: string; memberIds: string[]; description?: string; image?: string; companyId?: string; branchId?: string }) {
    if (!input.name?.trim()) throw BadRequest('Group name required');
    let companyId = input.companyId?.trim() || null;
    const branchId = input.branchId?.trim() || null;
    // Access guard: only super-admins / company-wide roles may create a group in a branch they don't
    // belong to (the New Group picker is access-scoped, but enforce it server-side too).
    if (branchId) {
      const access = await accessService.accessForUserId(userId);
      // Delegated group creators (GROUP_CREATE_EMAILS) are treated like a super here so they can
      // create a group in any branch, not just their own.
      const allowed = (await canCreateGroup(userId)) || (!!access && (access.companyWide || (access.branchIds ?? []).includes(branchId)));
      if (!allowed) throw Forbidden('You can only create groups in your own branch');
      // Anchor the group to its business: the branch's company must match the selected one
      // (or fills it in when omitted), so a group always lives under business → branch.
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
      members: participantIds.map((uid) => ({ userId: uid, role: uid === userId ? 'admin' : 'member', joinedAt: now, lastReadAt: uid === userId ? now : null, unread: 0, muted: false, mutedUntil: null, archived: false, pinned: false })),
      createdBy: userId,
      tenantId: me?.tenant_id ? String(me.tenant_id) : null,
      name: input.name.trim(),
      description: input.description ?? null,
      image: input.image ?? null,
      companyId, // business this group belongs to (validated/derived from the branch above)
      branchId, // branch this group belongs to
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
          $push: { members: { $each: toAdd.map((uid) => ({ userId: uid, role: 'member', joinedAt: new Date(), lastReadAt: null, unread: 0, muted: false, mutedUntil: null, archived: false, pinned: false })) } },
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

  // ── task chats (managed by the task service only) ──
  // One chat per task, started from inside the task by its giver, assignee or a watcher; members = assigner,
  // assignee, watchers. Closed (off the lists, read-only) with the task, reopened with it.
  async createTaskChat(actorId: string, input: { taskId: string; title: string; memberIds: string[]; companyId: string | null; branchId: string | null; notice: string }) {
    const participantIds = [...new Set([actorId, ...input.memberIds])];
    const me = await crmRepo.getUserById(actorId);
    const now = new Date();
    const conv = (await conversationRepo.create({
      type: 'task',
      taskId: input.taskId,
      participantIds,
      members: participantIds.map((uid) => ({ userId: uid, role: 'member', joinedAt: now, lastReadAt: uid === actorId ? now : null, unread: 0, muted: false, mutedUntil: null, archived: false, pinned: false })),
      createdBy: actorId,
      tenantId: me?.tenant_id ? String(me.tenant_id) : null,
      name: input.title,
      companyId: input.companyId,
      branchId: input.branchId,
      lastActivityAt: now,
    })) as unknown as ConversationDoc;
    await postSystemMessage(conv, actorId, input.notice, participantIds);
    emitToUsers(participantIds, CHAT_EVENTS.CONVERSATION_NEW, { conversationId: String(conv._id) });
    return String(conv._id);
  },

  // Make the chat's members exactly `memberIds` (who joined / left is the task service's notice to post).
  async setTaskChatMembers(conversationId: string, memberIds: string[]) {
    const conv = await conversationRepo.findById(conversationId);
    if (!conv || conv.type !== 'task') return;
    const want = [...new Set(memberIds)];
    const toAdd = want.filter((id) => !conv.participantIds.includes(id));
    const toRemove = conv.participantIds.filter((id) => !want.includes(id));
    if (!toAdd.length && !toRemove.length) return;
    if (toRemove.length) {
      await ConversationModel().updateOne({ _id: conv._id }, { $pull: { participantIds: { $in: toRemove }, members: { userId: { $in: toRemove } } } });
    }
    if (toAdd.length) {
      await ConversationModel().updateOne(
        { _id: conv._id },
        {
          $addToSet: { participantIds: { $each: toAdd } },
          $push: { members: { $each: toAdd.map((uid) => ({ userId: uid, role: 'member', joinedAt: new Date(), lastReadAt: null, unread: 0, muted: false, mutedUntil: null, archived: false, pinned: false })) } },
        },
      );
    }
    if (conv.closedAt) return; // closed task: nobody's list shows it, so there is nothing to refresh
    emitToUsers([...conv.participantIds, ...toAdd], CHAT_EVENTS.CONVERSATION_UPDATED, { conversationId });
    if (toAdd.length) emitToUsers(toAdd, CHAT_EVENTS.CONVERSATION_NEW, { conversationId });
    if (toRemove.length) emitToUsers(toRemove, CHAT_EVENTS.CONVERSATION_DELETED, { conversationId });
  },

  // The task was Closed / Cancelled: the chat leaves everyone's list (their apps drop it), its unread
  // badges clear, and it takes no new messages. Nothing is deleted — the task still reads it.
  async closeTaskChat(conversationId: string) {
    const conv = await conversationRepo.findById(conversationId);
    if (!conv || conv.type !== 'task' || conv.closedAt) return;
    await ConversationModel().updateOne({ _id: conv._id }, { $set: { closedAt: new Date(), 'members.$[].unread': 0 } });
    emitToUsers(conv.participantIds, CHAT_EVENTS.CONVERSATION_DELETED, { conversationId });
  },

  // The task was reopened: the chat comes back onto its members' lists, writable again.
  async reopenTaskChat(conversationId: string) {
    const conv = await conversationRepo.findById(conversationId);
    if (!conv || conv.type !== 'task' || !conv.closedAt) return;
    await ConversationModel().updateOne({ _id: conv._id }, { $set: { closedAt: null, lastActivityAt: new Date() } });
    emitToUsers(conv.participantIds, CHAT_EVENTS.CONVERSATION_NEW, { conversationId });
  },

  async renameTaskChat(conversationId: string, title: string) {
    const conv = await conversationRepo.findById(conversationId);
    if (!conv || conv.type !== 'task') return;
    await ConversationModel().updateOne({ _id: conv._id }, { $set: { name: title } });
    emitToUsers(conv.participantIds, CHAT_EVENTS.CONVERSATION_UPDATED, { conversationId });
  },

  // A system line in the task's chat ("Satish marked this Done – to close · 18 Nov, 4:12 pm").
  async postTaskNotice(conversationId: string, actorId: string, text: string) {
    const conv = await conversationRepo.findById(conversationId);
    if (!conv || conv.type !== 'task') return;
    await postSystemMessage(conv, actorId, text, conv.participantIds);
  },

  // Read a task chat without being a member — the task service has already checked that the reader
  // may see the task (a manager above the assignee). Read-only: posting still needs membership.
  async readTaskMessages(conversationId: string, viewerId: string, page: { before?: string; after?: string; limit?: number }) {
    const conv = await conversationRepo.findById(conversationId);
    if (!conv || conv.type !== 'task') throw NotFound('Task chat not found');
    const msgs = await messageRepo.listByConversation(conversationId, viewerId, page);
    return msgs.map((m) => toMessageDTO(m, viewerId));
  },

  async unreadFor(conversationIds: string[], userId: string): Promise<Record<string, number>> {
    if (!conversationIds.length) return {};
    const oids = conversationIds.filter((id) => Types.ObjectId.isValid(id)).map((id) => new Types.ObjectId(id));
    const convs = await ConversationModel().find({ _id: { $in: oids } }).select('_id members').lean<Pick<ConversationDoc, '_id' | 'members'>[]>();
    return Object.fromEntries(convs.map((c) => [String(c._id), c.members.find((m) => m.userId === userId)?.unread ?? 0]));
  },

  // The chats (of those given) in which a person has written: any message that is not one of the app's
  // own notices ("X started a chat about this task", status changes). A task's chat badge stays red
  // until then (owner, 2026-11-17).
  // One small lookup per chat that stops at its first message from a person (the conversationId
  // index): only "has anyone written" is asked, and a long task chat must not be read end to end for it.
  async withPeopleMessages(conversationIds: string[]): Promise<Set<string>> {
    const ids = [...new Set(conversationIds)].filter((id) => Types.ObjectId.isValid(id));
    const hits = await Promise.all(ids.map(async (id) =>
      (await MessageModel().exists({ conversationId: new Types.ObjectId(id), type: { $ne: 'system' } })) ? id : null));
    return new Set(hits.filter((id): id is string => id !== null));
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
