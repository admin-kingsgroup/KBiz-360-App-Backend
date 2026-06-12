import { Schema, type Model, type Types } from 'mongoose';
import { appDb } from '../connection';

// ───────────────────────── Types ─────────────────────────
export type CallMediaType = 'voice' | 'video';
// Live state of an in-progress call (active_calls). Terminal states live in call_logs.
export type ActiveCallStatus = 'ringing' | 'accepted';
// Terminal outcome persisted to call_logs.
export type CallLogStatus = 'completed' | 'missed' | 'rejected' | 'failed';

// ───────────── active_calls (one doc per in-flight call; TTL-cleaned) ─────────────
export interface ActiveCallDoc {
  _id: Types.ObjectId;
  callId: string; // app-generated correlation id (uuid), shared with the clients
  callerId: string;
  receiverId: string;
  type: CallMediaType;
  status: ActiveCallStatus;
  startedAt: Date; // when initiate happened
  acceptedAt: Date | null;
  expiresAt: Date; // TTL safety-net so a crashed/abandoned call self-cleans
  createdAt: Date;
  updatedAt: Date;
}

const ActiveCallSchema = new Schema<ActiveCallDoc>(
  {
    callId: { type: String, required: true, unique: true },
    callerId: { type: String, required: true, index: true },
    receiverId: { type: String, required: true, index: true },
    type: { type: String, enum: ['voice', 'video'], default: 'voice' },
    status: { type: String, enum: ['ringing', 'accepted'], default: 'ringing' },
    startedAt: { type: Date, default: Date.now },
    acceptedAt: { type: Date, default: null },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true, collection: 'active_calls' },
);
// TTL: documents are auto-removed once expiresAt passes (orphan/crash cleanup).
ActiveCallSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

// ───────────── call_logs (insert-only history; one doc per finished call) ─────────────
export interface CallLogDoc {
  _id: Types.ObjectId;
  callId: string;
  callerId: string;
  receiverId: string;
  type: CallMediaType;
  status: CallLogStatus;
  startedAt: Date;
  acceptedAt: Date | null;
  endedAt: Date;
  durationSec: number; // connected duration (0 for missed/rejected/failed)
  endedBy: string | null; // userId who ended it (or null for system/timeout)
  createdAt: Date;
  updatedAt: Date;
}

const CallLogSchema = new Schema<CallLogDoc>(
  {
    callId: { type: String, required: true, index: true },
    callerId: { type: String, required: true },
    receiverId: { type: String, required: true },
    type: { type: String, enum: ['voice', 'video'], default: 'voice' },
    status: { type: String, enum: ['completed', 'missed', 'rejected', 'failed'], required: true },
    startedAt: { type: Date, required: true },
    acceptedAt: { type: Date, default: null },
    endedAt: { type: Date, required: true },
    durationSec: { type: Number, default: 0 },
    endedBy: { type: String, default: null },
  },
  { timestamps: true, collection: 'call_logs' },
);
// Indexes for history (per participant, newest first), filtering and analytics.
CallLogSchema.index({ callerId: 1, createdAt: -1 });
CallLogSchema.index({ receiverId: 1, createdAt: -1 });
CallLogSchema.index({ status: 1 });
CallLogSchema.index({ createdAt: -1 });

// ───────────── push_devices (Expo push tokens, Mongo-only — used for incoming-call pushes) ─────────────
export interface PushDeviceDoc {
  _id: Types.ObjectId;
  userId: string;
  expoPushToken: string;
  platform: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const PushDeviceSchema = new Schema<PushDeviceDoc>(
  {
    userId: { type: String, required: true, index: true },
    expoPushToken: { type: String, required: true, unique: true },
    platform: { type: String, default: null },
  },
  { timestamps: true, collection: 'push_devices' },
);

// Lazily bound to the kb360_app connection (after connectMongo()).
let _ActiveCall: Model<ActiveCallDoc> | null = null;
let _CallLog: Model<CallLogDoc> | null = null;
let _PushDevice: Model<PushDeviceDoc> | null = null;

export function ActiveCallModel(): Model<ActiveCallDoc> {
  if (!_ActiveCall) _ActiveCall = appDb().model<ActiveCallDoc>('ActiveCall', ActiveCallSchema);
  return _ActiveCall;
}
export function CallLogModel(): Model<CallLogDoc> {
  if (!_CallLog) _CallLog = appDb().model<CallLogDoc>('CallLog', CallLogSchema);
  return _CallLog;
}
export function PushDeviceModel(): Model<PushDeviceDoc> {
  if (!_PushDevice) _PushDevice = appDb().model<PushDeviceDoc>('PushDevice', PushDeviceSchema);
  return _PushDevice;
}

// Create all indexes up-front (called once at boot). mongoose autoIndex also handles dev.
export async function ensureCallIndexes(): Promise<void> {
  await Promise.all([ActiveCallModel().createIndexes(), CallLogModel().createIndexes(), PushDeviceModel().createIndexes()]);
}
