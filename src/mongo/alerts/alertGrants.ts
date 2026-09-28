import { Types } from 'mongoose';
import { appDb } from '../connection';
import { crmRepo } from '../crm.repo';
import { accessService, type MongoAccess } from '../access';
import { ALERT_GRANT_IDS, effectiveGrants, grantableGrants, grantsWithinBranches, isBranchWideGrant } from './alertChannels';

// Per-user SYSTEM-ALERT visibility grants, controlled by super-admins (mirrors attendanceExempt).
// Stored in kb360_app (CRM is READ-ONLY). ABSENCE of a record = no grants; super-admins see every
// channel regardless (enforced in alertChannels.visibleChannelIds, never stored here).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const col = () => appDb().collection('alert_grants') as any;

// A directory row (directory.service mapUser) — enough to know which branches a user may hold alerts for.
export interface AlertGrantUser {
  id: string;
  level: number;
  branchIds: string[];
}

// The branch codes a user has access to; null = company-wide role (every branch and the hub).
async function branchCodesOf(branchIds: string[] | null): Promise<string[] | null> {
  if (branchIds === null) return null;
  const ids = branchIds.filter((id) => Types.ObjectId.isValid(id)).map((id) => new Types.ObjectId(id));
  return ids.length ? (await crmRepo.branchesByIds(ids)).map((b) => String(b.code ?? '').toUpperCase()).filter(Boolean) : [];
}

// The same, for a whole Team & Users list at once (one branches read, not one per user).
// userId → codes; null = company-wide. (Never `?? []` on the result: that would turn null into none.)
async function branchCodesByUser(users: AlertGrantUser[]): Promise<Record<string, string[] | null>> {
  const codeOf = new Map((await crmRepo.listBranches({})).map((b) => [String(b._id), String(b.code ?? '').toUpperCase()]));
  // Same rule as access.deriveAccess: level ≤ 2 (super_admin / company_manager) is company-wide.
  return Object.fromEntries(users.map((u) => [u.id, u.level <= 2 ? null : u.branchIds.map((id) => codeOf.get(id) ?? '').filter(Boolean)]));
}

export const alertGrants = {
  async setGrants(userId: string, alerts: string[], by: string): Promise<string[]> {
    // Branch-wide grants come from branch membership, never from a switch (isBranchWideGrant), and
    // a switch for a branch the user has no access to is never stored (grantsWithinBranches).
    const access = await accessService.accessForUserId(userId);
    const codes = access ? await branchCodesOf(access.branchIds) : [];
    const wanted = alerts.filter((a) => ALERT_GRANT_IDS.includes(a) && !isBranchWideGrant(a));
    const clean = [...new Set(grantsWithinBranches(wanted, codes))];
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

  // What the user can actually see: their stored grants for the branches they have access to PLUS
  // the branch-wide channels of those branches ("BOM-leads" for anyone in BOM, and only for them).
  // The feed, the attachment gate and auth (→ the app's access.alerts, which decides which cards
  // render) all read this — never grantsFor alone. Derived, never stored: moving a user between
  // branches moves their alerts.
  async effectiveFor(access: MongoAccess): Promise<string[]> {
    const stored = await this.grantsFor(access.userId);
    return effectiveGrants(stored, await branchCodesOf(access.branchIds));
  },

  // Grants for a set of users: { [userId]: grants[] } (missing record = []). Only the ones that
  // count are shown as held: a branch-wide grant stored before 2026-09-27, or one for a branch the
  // user has no access to, opens nothing — so its switch must not read as on.
  async mapFor(users: AlertGrantUser[]): Promise<Record<string, string[]>> {
    const map: Record<string, string[]> = {};
    for (const u of users) map[u.id] = [];
    const codes = await branchCodesByUser(users);
    const docs = await col().find({ userId: { $in: users.map((u) => u.id) } }).toArray();
    for (const d of docs as { userId: string; alerts?: string[] }[]) {
      const held = (d.alerts ?? []).filter((g) => !isBranchWideGrant(g));
      if (d.userId in codes) map[d.userId] = grantsWithinBranches(held, codes[d.userId]);
    }
    return map;
  },

  // The switches Team & Users offers each user: { [userId]: grants[] } — the grant-only channels
  // of the branches (and hub) they have access to; every one for a company-wide role.
  async grantableMapFor(users: AlertGrantUser[]): Promise<Record<string, string[]>> {
    const codes = await branchCodesByUser(users);
    return Object.fromEntries(users.map((u) => [u.id, grantableGrants(codes[u.id])]));
  },
};
