import { Types } from 'mongoose';
import { appDb } from '../connection';
import { crmRepo } from '../crm.repo';
import type { MongoAccess } from '../access';
import { ALERT_GRANT_IDS, effectiveGrants, isBranchWideGrant } from './alertChannels';

// Per-user SYSTEM-ALERT visibility grants, controlled by super-admins (mirrors attendanceExempt).
// Stored in kb360_app (CRM is READ-ONLY). ABSENCE of a record = no grants; super-admins see every
// channel regardless (enforced in alertChannels.visibleChannelIds, never stored here).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const col = () => appDb().collection('alert_grants') as any;

export const alertGrants = {
  async setGrants(userId: string, alerts: string[], by: string): Promise<string[]> {
    // Branch-wide grants come from branch membership, never from a switch (isBranchWideGrant).
    const clean = [...new Set(alerts.filter((a) => ALERT_GRANT_IDS.includes(a) && !isBranchWideGrant(a)))];
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

  // What the user can actually see: their stored grants PLUS the branch-wide channels of the
  // branches they belong to ("BOM-leads" for anyone in BOM, and only for them). The feed, the attachment gate and
  // auth (→ the app's access.alerts, which decides which cards render) all read this — never
  // grantsFor alone. Derived, never stored: moving a user between branches moves their alerts.
  async effectiveFor(access: MongoAccess): Promise<string[]> {
    const stored = await this.grantsFor(access.userId);
    let codes: string[] | null = null; // null = company-wide role → every branch
    if (access.branchIds !== null) {
      const ids = access.branchIds.filter((id) => Types.ObjectId.isValid(id)).map((id) => new Types.ObjectId(id));
      codes = ids.length ? (await crmRepo.branchesByIds(ids)).map((b) => String(b.code ?? '').toUpperCase()).filter(Boolean) : [];
    }
    return effectiveGrants(stored, codes);
  },

  // Grants for a set of users: { [userId]: grants[] } (missing record = []).
  async mapFor(userIds: string[]): Promise<Record<string, string[]>> {
    const map: Record<string, string[]> = {};
    for (const id of userIds) map[id] = [];
    const docs = await col().find({ userId: { $in: userIds } }).toArray();
    // A branch-wide grant stored before 2026-09-27 means nothing any more — don't show it as held.
    for (const d of docs as { userId: string; alerts?: string[] }[]) map[d.userId] = (d.alerts ?? []).filter((g) => !isBranchWideGrant(g));
    return map;
  },
};
