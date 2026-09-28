import { Types } from 'mongoose';
import { appDb } from '../connection';
import { crmRepo } from '../crm.repo';
import { accessService, type MongoAccess } from '../access';
import { ALERT_GRANT_IDS, effectiveGrants, grantableGrants, isBranchWideGrant, needsErpAccess, usableGrants } from './alertChannels';
import { erpAccessIdsFor } from './erpAccess';

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
export async function branchCodesByUser(users: AlertGrantUser[]): Promise<Record<string, string[] | null>> {
  const codeOf = new Map((await crmRepo.listBranches({})).map((b) => [String(b._id), String(b.code ?? '').toUpperCase()]));
  // Same rule as access.deriveAccess: level ≤ 2 (super_admin / company_manager) is company-wide.
  return Object.fromEntries(users.map((u) => [u.id, u.level <= 2 ? null : u.branchIds.map((id) => codeOf.get(id) ?? '').filter(Boolean)]));
}

export const alertGrants = {
  async setGrants(userId: string, alerts: string[], by: string): Promise<string[]> {
    // Branch-wide grants come from branch membership, never from a switch (isBranchWideGrant), and
    // a switch that cannot take effect — another branch's, or ERP without ERP access — is never
    // stored (usableGrants).
    const access = await accessService.accessForUserId(userId);
    const codes = access ? await branchCodesOf(access.branchIds) : [];
    const wanted = alerts.filter((a) => ALERT_GRANT_IDS.includes(a) && !isBranchWideGrant(a));
    const hasErp = wanted.some(needsErpAccess) ? (await erpAccessIdsFor([userId])).has(userId) : true;
    const clean = [...new Set(usableGrants(wanted, codes, hasErp))];
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

  // Stored grants for a set of users: { [userId]: grants[] } (missing record = []), unfiltered.
  async storedFor(userIds: string[]): Promise<Record<string, string[]>> {
    const map: Record<string, string[]> = Object.fromEntries(userIds.map((id) => [id, [] as string[]]));
    const docs = await col().find({ userId: { $in: userIds } }).toArray();
    for (const d of docs as { userId: string; alerts?: string[] }[]) map[d.userId] = d.alerts ?? [];
    return map;
  },

  // What the user can actually see: their stored grants that can take effect (their branches only;
  // ERP / ERP Reports only with ERP access) PLUS the branch-wide channels of their branches
  // ("BOM-leads" for anyone in BOM, and only for them). The feed, the attachment gate and auth
  // (→ the app's access.alerts, which decides which cards render) all read this — never grantsFor
  // alone. Derived, never stored: moving a user between branches moves their alerts.
  async effectiveFor(access: MongoAccess): Promise<string[]> {
    const stored = await this.grantsFor(access.userId);
    // Most users hold no ERP grant at all — only look ERP access up when it can change the answer.
    const hasErp = stored.some(needsErpAccess) ? (await erpAccessIdsFor([access.userId])).has(access.userId) : true;
    return effectiveGrants(stored, await branchCodesOf(access.branchIds), hasErp);
  },

  // Grants for a set of users: { [userId]: grants[] } (missing record = []). Only the ones that
  // count are shown as held: a branch-wide grant stored before 2026-09-27, one for a branch the
  // user has no access to, or an ERP one without ERP access opens nothing — so its switch must
  // not read as on.
  async mapFor(users: AlertGrantUser[]): Promise<Record<string, string[]>> {
    const ids = users.map((u) => u.id);
    const [codes, stored, erp] = await Promise.all([branchCodesByUser(users), this.storedFor(ids), erpAccessIdsFor(ids)]);
    return Object.fromEntries(ids.map((id) => [id, usableGrants(stored[id].filter((g) => !isBranchWideGrant(g)), codes[id], erp.has(id))]));
  },

  // The switches Team & Users offers each user: { [userId]: grants[] } — the grant-only channels
  // of the branches (and hub) they have access to (every one for a company-wide role), without
  // ERP / ERP Reports for someone who has no ERP access.
  async grantableMapFor(users: AlertGrantUser[]): Promise<Record<string, string[]>> {
    const ids = users.map((u) => u.id);
    const [codes, erp] = await Promise.all([branchCodesByUser(users), erpAccessIdsFor(ids)]);
    return Object.fromEntries(ids.map((id) => [id, grantableGrants(codes[id], erp.has(id))]));
  },
};
