import { Schema, type Model, type Types } from 'mongoose';
import { appDb } from '../mongo/connection';

// Apple PushKit VoIP tokens (iOS only) — separate from FCM tokens. Used by the APNs VoIP sender to
// wake a killed iOS app and report a native CallKit incoming call. Stored in kb360_app.
export interface VoipDeviceDoc {
  _id: Types.ObjectId;
  userId: string;
  voipToken: string;
  production: boolean; // which APNs environment this token belongs to (preview/store = true, dev = false)
  createdAt: Date;
  updatedAt: Date;
}

const VoipDeviceSchema = new Schema<VoipDeviceDoc>(
  {
    userId: { type: String, required: true, index: true },
    voipToken: { type: String, required: true, unique: true },
    production: { type: Boolean, default: true },
  },
  { timestamps: true, collection: 'voip_devices' },
);

let _model: Model<VoipDeviceDoc> | null = null;
function VoipDeviceModel(): Model<VoipDeviceDoc> {
  if (!_model) _model = appDb().model<VoipDeviceDoc>('VoipDevice', VoipDeviceSchema);
  return _model;
}

export const voipDeviceRepo = {
  upsert: (userId: string, voipToken: string, production: boolean) =>
    VoipDeviceModel().updateOne(
      { voipToken },
      { $set: { userId, production, updatedAt: new Date() }, $setOnInsert: { createdAt: new Date() } },
      { upsert: true },
    ),
  async devicesForUser(userId: string): Promise<{ voipToken: string; production: boolean }[]> {
    return VoipDeviceModel().find({ userId }).select('voipToken production').lean<{ voipToken: string; production: boolean }[]>();
  },
  remove: (voipToken: string) => VoipDeviceModel().deleteOne({ voipToken }),
};
