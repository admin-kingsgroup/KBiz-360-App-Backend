import { Schema, type Model } from 'mongoose';
import { appDb } from '../connection';

// Durable last-seen, one doc per user (_id = CRM user id). The in-memory Map in chat.events stays
// the synchronous read path; this collection is only its durability across restarts (hydrated at
// boot, stamped on connect/disconnect + a 60s heartbeat while online).
export interface UserPresenceDoc {
  _id: string; // CRM user id
  lastSeenAt: Date;
}

const UserPresenceSchema = new Schema<UserPresenceDoc>(
  { _id: { type: String, required: true }, lastSeenAt: { type: Date, required: true } },
  { collection: 'user_presence', versionKey: false },
);

// Lazily bound to the kb360_app connection (after connectMongo()).
let _UserPresence: Model<UserPresenceDoc> | null = null;
export function UserPresenceModel(): Model<UserPresenceDoc> {
  if (!_UserPresence) _UserPresence = appDb().model<UserPresenceDoc>('UserPresence', UserPresenceSchema);
  return _UserPresence;
}
