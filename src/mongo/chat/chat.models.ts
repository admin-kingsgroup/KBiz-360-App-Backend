import { Schema, type Model, type Types } from 'mongoose';
import { appDb } from '../connection';

// ─────────── Conversation (direct + group) ───────────
export interface ConvMember {
  userId: string;
  role: 'admin' | 'member';
  joinedAt: Date;
  lastReadAt: Date | null;
  unread: number;
  muted: boolean;
  mutedUntil: Date | null; // null with muted=true ⇒ muted forever (WhatsApp's "Always")
  archived: boolean;
  pinned: boolean;
}
export interface ConversationDoc {
  _id: Types.ObjectId;
  type: 'direct' | 'group';
  participantIds: string[]; // denormalized (fast membership + direct dedupe)
  members: ConvMember[];
  createdBy: string;
  tenantId: string | null;
  directKey: string | null; // sorted "a|b" for direct dedupe
  deptKey: string | null; // "<branchId>:<departmentId>" grouping key (NON-unique: a dept can have many groups)
  companyId: string | null; // business/company this group belongs to (company → branch → department → groups)
  branchId: string | null; // branch this group belongs to
  departmentId: string | null; // department this group belongs to (branch → department → many groups)
  name: string | null; // group
  description: string | null;
  image: string | null;
  lastMessage: { messageId: Types.ObjectId | null; text: string; type: string; senderId: string; at: Date } | null;
  // Disappearing messages: seconds after which a NEW message in this chat self-deletes (null = off).
  disappearAfterSec: number | null;
  lastActivityAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const MemberSchema = new Schema<ConvMember>(
  {
    userId: { type: String, required: true },
    role: { type: String, enum: ['admin', 'member'], default: 'member' },
    joinedAt: { type: Date, default: Date.now },
    lastReadAt: { type: Date, default: null },
    unread: { type: Number, default: 0 },
    muted: { type: Boolean, default: false },
    mutedUntil: { type: Date, default: null },
    archived: { type: Boolean, default: false },
    pinned: { type: Boolean, default: false },
  },
  { _id: false },
);

const ConversationSchema = new Schema<ConversationDoc>(
  {
    type: { type: String, enum: ['direct', 'group'], required: true },
    participantIds: { type: [String], required: true, index: true },
    members: { type: [MemberSchema], default: [] },
    createdBy: { type: String, required: true },
    tenantId: { type: String, default: null },
    // NOTE: no `default: null`. These back sparse-unique indexes; a sparse index still
    // indexes a doc whose field is present-but-null, so `default: null` makes the 2nd
    // doc-without-a-key collide (E11000). Leaving them unset means the field is absent and
    // correctly skipped by the sparse index. Real values are set explicitly where needed.
    directKey: { type: String },
    deptKey: { type: String },
    companyId: { type: String, default: null }, // business/company this group belongs to (not unique)
    branchId: { type: String, default: null }, // branch this group belongs to (not unique)
    departmentId: { type: String, default: null }, // department this group belongs to (not unique)
    name: { type: String, default: null },
    description: { type: String, default: null },
    image: { type: String, default: null },
    lastMessage: {
      type: new Schema(
        { messageId: { type: Schema.Types.ObjectId, default: null }, text: String, type: String, senderId: String, at: Date },
        { _id: false },
      ),
      default: null,
    },
    disappearAfterSec: { type: Number, default: null },
    lastActivityAt: { type: Date, default: Date.now, index: true },
  },
  { timestamps: true },
);
ConversationSchema.index({ directKey: 1 }, { unique: true, sparse: true });
// deptKey is NON-unique now — a (branch, department) can hold many groups. Just a lookup index.
ConversationSchema.index({ deptKey: 1 });
ConversationSchema.index({ participantIds: 1, lastActivityAt: -1 });

// ─────────── Message ───────────
export interface Attachment {
  url: string;
  name: string;
  size: number;
  mime: string;
  width?: number;
  height?: number;
  durationMs?: number;
  thumbnailUrl?: string;
  waveform?: number[];
}
export interface Reaction {
  userId: string;
  emoji: string;
  at: Date;
}
export interface MessageDoc {
  _id: Types.ObjectId;
  conversationId: Types.ObjectId;
  senderId: string;
  type: 'text' | 'image' | 'video' | 'document' | 'voice' | 'system';
  text: string;
  clientId: string | null; // sender's optimistic id — used for send-idempotency (no duplicate on retry)
  attachments: Attachment[];
  replyTo: { messageId: Types.ObjectId; senderId: string; preview: string; type: string } | null;
  forwardedFrom: { messageId: Types.ObjectId; conversationId: Types.ObjectId } | null;
  mentions: string[]; // userIds @-mentioned in `text` (participants only; pre-mentions docs lack the field)
  reactions: Reaction[];
  status: 'sent' | 'delivered' | 'read';
  sentAt: Date;
  deliveredAt: Date | null;
  readAt: Date | null;
  deliveredTo: string[];
  readBy: { userId: string; at: Date }[];
  starredBy: string[];
  pinned: boolean;
  pinnedBy: string | null;
  pinnedAt: Date | null;
  edited: boolean;
  editedAt: Date | null;
  deletedForEveryone: boolean;
  deletedFor: string[];
  // Disappearing messages: when set, Mongo's TTL monitor removes the document at this instant.
  expiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const MessageSchema = new Schema<MessageDoc>(
  {
    conversationId: { type: Schema.Types.ObjectId, required: true, index: true },
    senderId: { type: String, required: true, index: true },
    type: { type: String, enum: ['text', 'image', 'video', 'document', 'voice', 'system'], default: 'text' },
    text: { type: String, default: '' },
    clientId: { type: String, default: null },
    attachments: { type: [new Schema<Attachment>({}, { _id: false, strict: false })], default: [] },
    replyTo: {
      type: new Schema({ messageId: Schema.Types.ObjectId, senderId: String, preview: String, type: String }, { _id: false }),
      default: null,
    },
    forwardedFrom: {
      type: new Schema({ messageId: Schema.Types.ObjectId, conversationId: Schema.Types.ObjectId }, { _id: false }),
      default: null,
    },
    mentions: { type: [String], default: [] },
    reactions: { type: [new Schema<Reaction>({ userId: String, emoji: String, at: Date }, { _id: false })], default: [] },
    status: { type: String, enum: ['sent', 'delivered', 'read'], default: 'sent', index: true },
    sentAt: { type: Date, default: Date.now },
    deliveredAt: { type: Date, default: null },
    readAt: { type: Date, default: null },
    deliveredTo: { type: [String], default: [] },
    readBy: { type: [new Schema({ userId: String, at: Date }, { _id: false })], default: [] },
    starredBy: { type: [String], default: [] },
    pinned: { type: Boolean, default: false },
    pinnedBy: { type: String, default: null },
    pinnedAt: { type: Date, default: null },
    edited: { type: Boolean, default: false },
    editedAt: { type: Date, default: null },
    deletedForEveryone: { type: Boolean, default: false },
    deletedFor: { type: [String], default: [] },
    expiresAt: { type: Date, default: null },
  },
  { timestamps: true },
);
// Disappearing messages: Mongo deletes the document itself once expiresAt passes (sparse — messages
// in normal chats carry no expiry and are never touched). Devices drop their local copy in parallel.
MessageSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0, sparse: true });
MessageSchema.index({ conversationId: 1, createdAt: -1 });
MessageSchema.index({ conversationId: 1, clientId: 1 }, { sparse: true }); // send-idempotency lookup
// Catch-up sync: "everything in my conversations that changed since <watermark>" — created, edited,
// deleted, reacted to, or newly ticked. Local-first clients replay this once per connect instead of
// re-fetching each thread on open.
MessageSchema.index({ conversationId: 1, updatedAt: 1 });
MessageSchema.index({ conversationId: 1, pinned: 1 });
MessageSchema.index({ text: 'text' });

// Lazily bound to the kb360_app connection (after connectMongo()).
let _Conversation: Model<ConversationDoc> | null = null;
let _Message: Model<MessageDoc> | null = null;
export function ConversationModel(): Model<ConversationDoc> {
  if (!_Conversation) _Conversation = appDb().model<ConversationDoc>('Conversation', ConversationSchema);
  return _Conversation;
}
export function MessageModel(): Model<MessageDoc> {
  if (!_Message) _Message = appDb().model<MessageDoc>('Message', MessageSchema);
  return _Message;
}

// Drops the LEGACY unique deptKey index (so a department can hold many groups), then syncs the current
// index set. We drop it explicitly first (not just syncIndexes) to be certain it's gone. Safe at startup.
export async function ensureChatIndexes(): Promise<void> {
  const model = ConversationModel();
  try {
    const existing = await model.collection.indexes();
    const legacy = existing.find((ix) => ix.key && (ix.key as Record<string, number>).deptKey === 1 && ix.unique);
    if (legacy?.name) {
      await model.collection.dropIndex(legacy.name);
      // eslint-disable-next-line no-console
      console.log(`[kb360] dropped legacy unique deptKey index "${legacy.name}" — many groups per department now allowed`);
    }
  } catch { /* collection/index may not exist yet — ignore */ }
  await model.syncIndexes();
  // Messages gained the delta-sync and disappearing-message (TTL) indexes — build them too, or
  // catch-up sync collection-scans and expired messages never actually get removed.
  // createIndexes, NOT syncIndexes: sync DROPS any index the schema does not declare, so a hand-built
  // index added on the live cluster for an ad-hoc query would silently vanish on the next deploy —
  // and rebuilding one on a grown messages collection is not something a restart should decide to do.
  await MessageModel().createIndexes();
  await ChatSettingsModel().createIndexes();
  await StatusModel().createIndexes();
}

// ─────────── Per-user chat settings (privacy + blocks) ───────────
// WhatsApp keeps these on the account, not the conversation: who may see your last seen, whether you
// send read receipts, and who you have blocked.
export interface ChatSettingsDoc {
  _id: Types.ObjectId;
  userId: string;
  readReceipts: boolean;          // off ⇒ you send none AND see none (WhatsApp's reciprocal rule)
  lastSeen: 'everyone' | 'nobody';
  blocked: string[];              // userIds this user has blocked
  createdAt: Date;
  updatedAt: Date;
}
const ChatSettingsSchema = new Schema<ChatSettingsDoc>(
  {
    userId: { type: String, required: true, unique: true },
    readReceipts: { type: Boolean, default: true },
    lastSeen: { type: String, enum: ['everyone', 'nobody'], default: 'everyone' },
    blocked: { type: [String], default: [] },
  },
  { timestamps: true },
);
let _ChatSettings: Model<ChatSettingsDoc> | null = null;
export function ChatSettingsModel(): Model<ChatSettingsDoc> {
  if (!_ChatSettings) _ChatSettings = appDb().model<ChatSettingsDoc>('ChatSettings', ChatSettingsSchema);
  return _ChatSettings;
}

// ─────────── Status (WhatsApp "Status" / stories) ───────────
// A photo, video or text card that expires 24 hours after posting. Mongo's TTL monitor removes the
// document itself, so nothing has to sweep them and no expired status can leak through a stale query.
export interface StatusDoc {
  _id: Types.ObjectId;
  userId: string;
  type: 'image' | 'video' | 'text';
  caption: string;
  attachment: Attachment | null;   // null for text-only cards
  backgroundColor: string | null;  // text cards carry their own colour, like WhatsApp's
  viewers: { userId: string; at: Date }[];
  audience: string[];              // who may see it — the poster's branch/company cohort
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}
const StatusSchema = new Schema<StatusDoc>(
  {
    userId: { type: String, required: true, index: true },
    type: { type: String, enum: ['image', 'video', 'text'], required: true },
    caption: { type: String, default: '' },
    attachment: { type: new Schema<Attachment>({}, { _id: false, strict: false }), default: null },
    backgroundColor: { type: String, default: null },
    viewers: { type: [new Schema({ userId: String, at: Date }, { _id: false })], default: [] },
    audience: { type: [String], default: [] },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true },
);
StatusSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 }); // 24h self-cleanup
StatusSchema.index({ audience: 1, createdAt: -1 });

let _Status: Model<StatusDoc> | null = null;
export function StatusModel(): Model<StatusDoc> {
  if (!_Status) _Status = appDb().model<StatusDoc>('Status', StatusSchema);
  return _Status;
}
