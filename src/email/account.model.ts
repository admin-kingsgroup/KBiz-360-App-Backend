import { Schema, type Model, type Types } from 'mongoose';
import { appDb } from '../mongo/connection';

// One connected Microsoft 365 mailbox per kb360 user. Stored in kb360_app. The refresh token is
// encrypted (see crypto.ts); the access token is a short-lived (~1h) cache.
export interface EmailAccountDoc {
  _id: Types.ObjectId;
  userId: string; // kb360 user id (unique)
  email: string; // the connected mailbox address
  msUserId: string | null;
  refreshTokenEnc: string;
  accessToken: string | null;
  accessTokenExpiresAt: Date | null;
  scope: string | null;
  lastPolledAt: Date | null; // new-mail poll cursor
  connectedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const EmailAccountSchema = new Schema<EmailAccountDoc>(
  {
    userId: { type: String, required: true, unique: true },
    email: { type: String, required: true },
    msUserId: { type: String, default: null },
    refreshTokenEnc: { type: String, required: true },
    accessToken: { type: String, default: null },
    accessTokenExpiresAt: { type: Date, default: null },
    scope: { type: String, default: null },
    lastPolledAt: { type: Date, default: null },
    connectedAt: { type: Date, default: () => new Date() },
  },
  { timestamps: true, collection: 'email_accounts' },
);

let _model: Model<EmailAccountDoc> | null = null;
function EmailAccountModel(): Model<EmailAccountDoc> {
  if (!_model) _model = appDb().model<EmailAccountDoc>('EmailAccount', EmailAccountSchema);
  return _model;
}

export const emailAccountRepo = {
  find: (userId: string) => EmailAccountModel().findOne({ userId }).lean<EmailAccountDoc>(),
  all: () => EmailAccountModel().find({}).lean<EmailAccountDoc[]>(),
  upsert: (userId: string, set: Partial<EmailAccountDoc>) =>
    EmailAccountModel().updateOne({ userId }, { $set: { ...set, updatedAt: new Date() }, $setOnInsert: { userId, connectedAt: new Date() } }, { upsert: true }),
  update: (userId: string, set: Partial<EmailAccountDoc>) => EmailAccountModel().updateOne({ userId }, { $set: { ...set, updatedAt: new Date() } }),
  remove: (userId: string) => EmailAccountModel().deleteOne({ userId }),
};
