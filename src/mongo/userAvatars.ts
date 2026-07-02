import { appDb } from './connection';

// Per-user PROFILE PICTURE url, set by the user. The CRM is READ-ONLY, so avatars live in kb360_app and
// are merged into the directory + chat DTOs so the photo shows everywhere (profile, chat list, headers,
// member lists). Absence of a record = no photo (fall back to initials).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const col = () => appDb().collection('user_avatars') as any;

export const userAvatars = {
  async setAvatar(userId: string, url: string | null): Promise<void> {
    if (!url) { await col().deleteOne({ userId }); return; }
    await col().updateOne({ userId }, { $set: { userId, url, updatedAt: new Date() } }, { upsert: true });
  },

  async urlFor(userId: string): Promise<string | null> {
    const doc = await col().findOne({ userId });
    return doc?.url ? String(doc.url) : null;
  },

  // Map of userId → avatar url for the given users (only users with a photo appear).
  async mapFor(userIds: string[]): Promise<Record<string, string>> {
    const map: Record<string, string> = {};
    if (!userIds.length) return map;
    const docs = await col().find({ userId: { $in: userIds } }).toArray();
    for (const d of docs) if (d.url) map[String(d.userId)] = String(d.url);
    return map;
  },
};
