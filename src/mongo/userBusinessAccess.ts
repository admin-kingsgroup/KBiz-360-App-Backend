import { appDb } from './connection';

// Per-user explicit BUSINESS access grants, set by super-admins in Team & Users. Role-derived
// access stays primary: company-wide roles (level ≤ 2) see every business regardless, and holding
// a branch grants its business implicitly. These grants ADD businesses a user should see without
// branch membership (e.g. a new business that has no branches yet). The CRM is READ-ONLY from this
// app, so grants live in kb360_app. Absence of a record = no extra grants.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const col = () => appDb().collection('user_business_access') as any;

export const userBusinessAccess = {
  // Replace a user's grant list (empty clears the record).
  async setBusinesses(userId: string, businessIds: string[], by: string): Promise<void> {
    const ids = [...new Set(businessIds.map((s) => String(s).trim()).filter(Boolean))];
    if (!ids.length) {
      await col().deleteOne({ userId });
      return;
    }
    await col().updateOne(
      { userId },
      { $set: { userId, businessIds: ids, updatedBy: by, updatedAt: new Date() } },
      { upsert: true },
    );
  },

  async listFor(userId: string): Promise<string[]> {
    const doc = await col().findOne({ userId });
    return Array.isArray(doc?.businessIds) ? doc.businessIds.map(String) : [];
  },

  // Map of userId → granted business ids (only users that have grants appear).
  async mapFor(userIds: string[]): Promise<Record<string, string[]>> {
    const map: Record<string, string[]> = {};
    if (!userIds.length) return map;
    const docs = await col().find({ userId: { $in: userIds } }).toArray();
    for (const d of docs) if (Array.isArray(d.businessIds)) map[String(d.userId)] = d.businessIds.map(String);
    return map;
  },
};
