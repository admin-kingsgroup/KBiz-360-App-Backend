import { appDb } from './connection';

// Per-user APP ACCESS gate, controlled by super-admins. Stored in kb360_app (the CRM is READ-ONLY, so
// this cannot live on the CRM user). ABSENCE of a record = ENABLED, so existing users are never locked
// out by default — only an explicit `enabled:false` blocks them. A short in-memory cache of the
// disabled set keeps the per-request auth check cheap.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const col = () => appDb().collection('app_access') as any;

let disabledCache: Set<string> | null = null;
let cacheAt = 0;
const CACHE_TTL_MS = 15000;

export const appAccess = {
  async isEnabled(userId: string): Promise<boolean> {
    const doc = await col().findOne({ userId });
    return doc ? doc.enabled !== false : true;
  },

  async setEnabled(userId: string, enabled: boolean, by: string): Promise<void> {
    await col().updateOne(
      { userId },
      { $set: { userId, enabled, updatedBy: by, updatedAt: new Date() } },
      { upsert: true },
    );
    disabledCache = null; // invalidate so the gate reflects the change immediately
  },

  // Access state for a set of users (defaults to true where there's no record).
  async statesFor(userIds: string[]): Promise<Record<string, boolean>> {
    const map: Record<string, boolean> = {};
    for (const id of userIds) map[id] = true;
    if (!userIds.length) return map;
    const docs = await col().find({ userId: { $in: userIds } }).toArray();
    for (const d of docs) map[String(d.userId)] = d.enabled !== false;
    return map;
  },

  async disabledSet(): Promise<Set<string>> {
    if (disabledCache && Date.now() - cacheAt < CACHE_TTL_MS) return disabledCache;
    const docs = await col().find({ enabled: false }).project({ userId: 1 }).toArray();
    disabledCache = new Set(docs.map((d: { userId: string }) => String(d.userId)));
    cacheAt = Date.now();
    return disabledCache;
  },

  async isDisabled(userId: string): Promise<boolean> {
    return (await this.disabledSet()).has(userId);
  },
};
