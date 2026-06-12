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
  archived: boolean;
}
export interface ConversationDoc {
  _id: Types.ObjectId;
  type: 'direct' | 'group';
  participantIds: string[]; // denormalized (fast membership + direct dedupe)
  members: ConvMember[];
  createdBy: string;
  tenantId: string | null;
  directKey: string | null; // sorted "a|b" for direct dedupe
  name: string | null; // group
  description: string | null;
  image: string | null;
  lastMessage: { messageId: Types.ObjectId | null; text: string; type: string; senderId: string; at: Date } | null;
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
    archived: { type: Boolean, default: false },
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
    directKey: { type: String, default: null },
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
    lastActivityAt: { type: Date, default: Date.now, index: true },
  },
  { timestamps: true },
);
ConversationSchema.index({ directKey: 1 }, { unique: true, sparse: true });
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
  attachments: Attachment[];
  replyTo: { messageId: Types.ObjectId; senderId: string; preview: string; type: string } | null;
  forwardedFrom: { messageId: Types.ObjectId; conversationId: Types.ObjectId } | null;
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
  createdAt: Date;
  updatedAt: Date;
}

const MessageSchema = new Schema<MessageDoc>(
  {
    conversationId: { type: Schema.Types.ObjectId, required: true, index: true },
    senderId: { type: String, required: true, index: true },
    type: { type: String, enum: ['text', 'image', 'video', 'document', 'voice', 'system'], default: 'text' },
    text: { type: String, default: '' },
    attachments: { type: [new Schema<Attachment>({}, { _id: false, strict: false })], default: [] },
    replyTo: {
      type: new Schema({ messageId: Schema.Types.ObjectId, senderId: String, preview: String, type: String }, { _id: false }),
      default: null,
    },
    forwardedFrom: {
      type: new Schema({ messageId: Schema.Types.ObjectId, conversationId: Schema.Types.ObjectId }, { _id: false }),
      default: null,
    },
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
  },
  { timestamps: true },
);
MessageSchema.index({ conversationId: 1, createdAt: -1 });
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
