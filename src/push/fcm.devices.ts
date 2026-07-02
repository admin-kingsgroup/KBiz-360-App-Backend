import { Schema, type Model, type Types } from 'mongoose';
import { appDb } from '../mongo/connection';

// Raw FCM registration tokens (separate from push_devices' Expo tokens), used by firebase-admin to
// send data messages for the native full-screen incoming-call UI. Stored in kb360_app.
export interface FcmDeviceDoc {
  _id: Types.ObjectId;
  userId: string;
  fcmToken: string;
  platform: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const FcmDeviceSchema = new Schema<FcmDeviceDoc>(
  {
    userId: { type: String, required: true, index: true },
    fcmToken: { type: String, required: true, unique: true },
    platform: { type: String, default: null },
  },
  { timestamps: true, collection: 'fcm_devices' },
);

let _model: Model<FcmDeviceDoc> | null = null;
function FcmDeviceModel(): Model<FcmDeviceDoc> {
  if (!_model) _model = appDb().model<FcmDeviceDoc>('FcmDevice', FcmDeviceSchema);
  return _model;
}

export const fcmDeviceRepo = {
  upsert: (userId: string, fcmToken: string, platform: string | null) =>
    FcmDeviceModel().updateOne(
      { fcmToken },
      { $set: { userId, platform, updatedAt: new Date() }, $setOnInsert: { createdAt: new Date() } },
      { upsert: true },
    ),
  async tokensForUser(userId: string): Promise<string[]> {
    const rows = await FcmDeviceModel().find({ userId }).select('fcmToken').lean<{ fcmToken: string }[]>();
    return rows.map((r) => r.fcmToken);
  },
  async devicesForUser(userId: string): Promise<{ fcmToken: string; platform: string | null }[]> {
    return FcmDeviceModel().find({ userId }).select('fcmToken platform').lean<{ fcmToken: string; platform: string | null }[]>();
  },
  removeByToken: (fcmToken: string) => FcmDeviceModel().deleteOne({ fcmToken }),
};
