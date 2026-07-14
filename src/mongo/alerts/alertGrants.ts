import { appDb } from '../connection';
import { ALERT_GRANT_IDS } from './alertChannels';

// Per-user SYSTEM-ALERT visibility grants, controlled by super-admins (mirrors attendanceExempt).
// Stored in kb360_app (CRM is READ-ONLY). ABSENCE of a record = no grants; super-admins see every
// channel regardless (enforced in alertChannels.visibleChannelIds, never stored here).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const col = () => appDb().collection('alert_grants') as any;

export const alertGrants = {
  async setGrants(userId: string, alerts: string[], by: string): Promise<string[]> {
    const clean = [...new Set(alerts.filter((a) => ALERT_GRANT_IDS.includes(a)))];
    if (clean.length) {
      await col().updateOne({ userId }, { $set: { userId, alerts: clean, updatedBy: by, updatedAt: new Date() } }, { upsert: true });
    } else {
      await col().deleteOne({ userId });
    }
    return clean;
  },

  async grantsFor(userId: string): Promise<string[]> {
    const doc = await col().findOne({ userId });
    return (doc?.alerts as string[] | undefined) ?? [];
  },

  // Grants for a set of users: { [userId]: grants[] } (missing record = []).
  async mapFor(userIds: string[]): Promise<Record<string, string[]>> {
    const map: Record<string, string[]> = {};
    for (const id of userIds) map[id] = [];
    const docs = await col().find({ userId: { $in: userIds } }).toArray();
    for (const d of docs as { userId: string; alerts?: string[] }[]) map[d.userId] = d.alerts ?? [];
    return map;
  },
};
