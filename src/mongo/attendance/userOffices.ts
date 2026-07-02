import { appDb } from '../connection';

// Per-user OFFICE ASSIGNMENT: locks a user to a specific office geofence (e.g. Faiz & Sughra → Bombay
// HQ), overriding their branch's default office. Stored in kb360_app (CRM is READ-ONLY). Absence of a
// record = no override → the user falls back to their branch's default office.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const col = () => appDb().collection('user_offices') as any;

export const userOffices = {
  // Assign a user to an office, or clear the assignment when officeId is null/blank.
  async setOffice(userId: string, officeId: string | null, by: string): Promise<void> {
    if (!officeId) {
      await col().deleteOne({ userId });
      return;
    }
    await col().updateOne(
      { userId },
      { $set: { userId, officeId, updatedBy: by, updatedAt: new Date() } },
      { upsert: true },
    );
  },

  async officeIdFor(userId: string): Promise<string | null> {
    const doc = await col().findOne({ userId });
    return doc?.officeId ? String(doc.officeId) : null;
  },

  // Map of userId → officeId for the given users (only assigned users appear).
  async mapFor(userIds: string[]): Promise<Record<string, string>> {
    const map: Record<string, string> = {};
    if (!userIds.length) return map;
    const docs = await col().find({ userId: { $in: userIds } }).toArray();
    for (const d of docs) if (d.officeId) map[String(d.userId)] = String(d.officeId);
    return map;
  },

  // userIds assigned to a given office (so the admin can show/manage an office's roster).
  async usersForOffice(officeId: string): Promise<string[]> {
    const docs = await col().find({ officeId }).toArray();
    return docs.map((d: { userId: string }) => String(d.userId));
  },
};
