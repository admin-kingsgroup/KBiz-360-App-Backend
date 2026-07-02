import { appDb } from './connection';

// Per-user POSITION / job title (e.g. "Senior Finance Manager"), set by super-admins. This is display
// metadata distinct from the user's ROLE (which comes from the CRM and drives access). The CRM is
// READ-ONLY, so positions live in kb360_app. Absence of a record = no custom position.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const col = () => appDb().collection('user_positions') as any;

export const userPositions = {
  // Set (or clear, when blank) a user's position.
  async setPosition(userId: string, position: string, by: string): Promise<void> {
    const value = position.trim();
    if (!value) {
      await col().deleteOne({ userId });
      return;
    }
    await col().updateOne(
      { userId },
      { $set: { userId, position: value, updatedBy: by, updatedAt: new Date() } },
      { upsert: true },
    );
  },

  // Map of userId → position for the given users (only users that have one appear).
  async mapFor(userIds: string[]): Promise<Record<string, string>> {
    const map: Record<string, string> = {};
    if (!userIds.length) return map;
    const docs = await col().find({ userId: { $in: userIds } }).toArray();
    for (const d of docs) if (d.position) map[String(d.userId)] = String(d.position);
    return map;
  },
};
