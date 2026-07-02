import { appDb } from './connection';

// Per-user ATTENDANCE EXEMPTION, controlled by super-admins. Some people (owners/directors) don't punch
// in/out — they're exempt: skipped by check-in/out and hidden from the team view. Stored in kb360_app
// (CRM is READ-ONLY). ABSENCE of a record = TRACKED; only an explicit exempt:true opts a user out. A
// short in-memory cache keeps the per-punch check cheap.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const col = () => appDb().collection('attendance_exempt') as any;

let exemptCache: Set<string> | null = null;
let cacheAt = 0;
const CACHE_TTL_MS = 15000;

export const attendanceExempt = {
  async setExempt(userId: string, exempt: boolean, by: string): Promise<void> {
    if (exempt) {
      await col().updateOne({ userId }, { $set: { userId, exempt: true, updatedBy: by, updatedAt: new Date() } }, { upsert: true });
    } else {
      await col().deleteOne({ userId });
    }
    exemptCache = null; // invalidate so the change takes effect immediately
  },

  async exemptSet(): Promise<Set<string>> {
    if (exemptCache && Date.now() - cacheAt < CACHE_TTL_MS) return exemptCache;
    const docs = await col().find({ exempt: true }).project({ userId: 1 }).toArray();
    exemptCache = new Set(docs.map((d: { userId: string }) => String(d.userId)));
    cacheAt = Date.now();
    return exemptCache;
  },

  async isExempt(userId: string): Promise<boolean> {
    return (await this.exemptSet()).has(userId);
  },

  // Tracking state for a set of users: { [userId]: tracked } (tracked = NOT exempt).
  async statesFor(userIds: string[]): Promise<Record<string, boolean>> {
    const map: Record<string, boolean> = {};
    for (const id of userIds) map[id] = true;
    const exempt = await this.exemptSet();
    for (const id of userIds) if (exempt.has(id)) map[id] = false;
    return map;
  },
};
