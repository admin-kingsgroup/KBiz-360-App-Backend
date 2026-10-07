import { Router, type Request } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../common/asyncHandler';
import { validate } from '../../common/validate';
import { BadRequest, Forbidden } from '../../common/errors';
import { crmRepo, type CrmRole, type CrmUser } from '../crm.repo';
import { appAccess } from '../appAccess';
import { emitToUser } from '../chat/chat.events';
import { requireServiceToken } from './serviceAuth';
import { ALERT_CHANNELS, canonicalBranchCode, channelGroup, grantableGrants } from './alertChannels';
import { alertGrants } from './alertGrants';

// /api/service/alert-access — the door KBiz Books (the ERP) uses to manage WHICH app user sees
// WHICH alert channel. Owner, 2026-10-07: "management of all alerts in the ERP" — the alerts still
// appear in the app, but the switches live in the ERP. It writes the SAME kb360_app.alert_grants the
// app's Team & Users 🔔 modal writes (alertGrants.setGrants), so the two never disagree, and every
// rule stays here: the branch rule (grantsWithinBranches), branch-wide channels never being a
// switch, the company-wide KGD Alerts being grantable to everyone.
//
// Authenticated like the reminders door (remindersService.router): the shared service secret
// (ALERTS_INGEST_TOKEN, Bearer or X-Service-Token) — NOT a user JWT, so it is mounted BEFORE the
// /api-wide chatRouter — and `X-Act-As` naming the ERP user doing it (an active user in the shared
// users collection). Who may open the ERP screen is the ERP's call; the actor scopes the user list
// to their tenant and is stamped on every change (updatedBy "erp:<id>").
export const alertAccessServiceRouter: Router = Router();
alertAccessServiceRouter.use(requireServiceToken);

const nameOf = (u: CrmUser): string => `${u.first_name ?? ''} ${u.last_name ?? ''}`.trim() || u.email || 'Unknown';
const isActive = (u: CrmUser): boolean => !u.status || u.status === 'active';

async function actor(req: Request): Promise<CrmUser> {
  const raw = req.headers['x-act-as'];
  const id = (Array.isArray(raw) ? raw[0] : raw ?? '').trim();
  if (!id) throw BadRequest('X-Act-As (the acting user id) is required');
  const user = await crmRepo.getUserById(id);
  if (!user) throw Forbidden('Acting user not found');
  if (!isActive(user)) throw Forbidden('Acting user is not active');
  return user;
}

// One app user as the ERP screen shows them. `codes` is what the branch rule reads: null for a
// company-wide role (super_admin / company_manager, level ≤ 2 — same rule as access.deriveAccess),
// which may hold every branch's switches.
interface AppUserRow {
  id: string;
  name: string;
  email: string;
  branchCodes: string[];
  isSuper: boolean;
  level: number;
  branchIds: string[];
  codes: string[] | null;
}

// The users whose alerts the ERP manages: everyone in the actor's tenant who can use the app —
// active, ERP App Access on (access.app === true, the login gate's own rule) and not switched off
// in the app's Team & Users. Sorted by name.
async function appUsers(me: CrmUser): Promise<AppUserRow[]> {
  const [users, roles, branches, disabled] = await Promise.all([
    crmRepo.listUsers(me.tenant_id ? { tenant_id: me.tenant_id } : {}),
    crmRepo.listRoles(),
    crmRepo.listBranches({}),
    appAccess.disabledSet(),
  ]);
  const roleOf = new Map<string, CrmRole>(roles.map((r) => [String(r._id), r]));
  // HNBO/HDAR/HFBM rows read as NBO/DAR/FBM, like every other branch code in the alerts.
  const codeOf = new Map(branches.map((b) => [String(b._id), canonicalBranchCode(b.code)]));
  return users
    .filter((u) => isActive(u) && u.access?.app === true && !disabled.has(String(u._id)))
    .map((u) => {
      const role = u.role_id ? roleOf.get(String(u.role_id)) : undefined;
      const level = role?.level ?? 5; // a missing role counts as level 5 (access.deriveAccess)
      const branchIds = (u.branch_ids ?? []).map(String);
      const branchCodes = [...new Set(branchIds.map((id) => codeOf.get(id) ?? '').filter(Boolean))];
      return {
        id: String(u._id),
        name: nameOf(u),
        email: u.email,
        branchCodes,
        isSuper: level === 1 || (role?.permissions ?? []).includes('*'),
        level,
        branchIds,
        codes: level <= 2 ? null : branchCodes,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

// GET /api/service/alert-access → { channels, users }. Every channel is listed with its Alerts
// group; branch-wide ones (CRM, CRM Reports) are shown for information — everyone in the branch
// sees them — but are never a switch, so they never appear in a user's `grantable`. `grants` = the
// stored switches that count (same as GET /api/admin/alert-visibility); `grantable` = the switches
// this user may hold: their branches' grant-only channels plus the company-wide KGD Alerts.
alertAccessServiceRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const me = await actor(req);
    const rows = await appUsers(me);
    const stored = await alertGrants.mapFor(rows.map((r) => ({ id: r.id, level: r.level, branchIds: r.branchIds })));
    res.json({
      channels: ALERT_CHANNELS.map((c) => ({
        id: c.id,
        name: c.name,
        branchCode: c.branchCode,
        module: c.module,
        grant: c.grant,
        branchWide: !!c.branchWide,
        companyWide: !!c.companyWide,
        group: channelGroup(c),
      })),
      users: rows.map((r) => ({
        id: r.id,
        name: r.name,
        email: r.email,
        branchCodes: r.branchCodes,
        isSuper: r.isSuper,
        grants: stored[r.id] ?? [],
        grantable: grantableGrants(r.codes),
      })),
    });
  }),
);

// POST /api/service/alert-access/grant { userId, grant, on } → { userId, grants } — switch ONE
// alert channel on or off for one app user. Only a switch in that user's `grantable` is accepted
// (400 otherwise — another branch's channel, a branch-wide one, an unknown grant, or a user who is
// not an active app user). The user's live app hears 'alert:visibility' exactly as after a change
// from Team & Users, so their Alerts tab updates without a re-login.
alertAccessServiceRouter.post(
  '/grant',
  validate(z.object({
    userId: z.string().trim().min(1).max(64),
    grant: z.string().trim().min(1).max(80),
    on: z.boolean(),
  })),
  asyncHandler(async (req, res) => {
    const me = await actor(req);
    const { userId, grant, on } = req.body as { userId: string; grant: string; on: boolean };
    const target = (await appUsers(me)).find((r) => r.id === userId);
    if (!target) throw BadRequest(`User ${userId} is not an active app user`);
    if (!grantableGrants(target.codes).includes(grant)) {
      throw BadRequest(`Alert grant "${grant}" cannot be switched for this user`);
    }
    const current = await alertGrants.grantsFor(userId);
    const wanted = on ? [...current, grant] : current.filter((g) => g !== grant);
    const saved = await alertGrants.setGrants(userId, wanted, `erp:${String(me._id)}`);
    emitToUser(userId, 'alert:visibility', { alerts: saved });
    res.json({ userId, grants: saved });
  }),
);
