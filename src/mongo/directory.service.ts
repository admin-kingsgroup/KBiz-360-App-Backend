import { Types } from 'mongoose';
import * as bcrypt from 'bcryptjs';
import { crmRepo, type CrmBranch, type CrmCompany, type CrmRole, type CrmUser } from './crm.repo';
import { userPositions } from './userPositions';
import { userAvatars } from './userAvatars';
import { userBusinessAccess } from './userBusinessAccess';
import { accessService, type MongoAccess } from './access';
import { appAccess } from './appAccess';
import { Forbidden, BadRequest } from '../common/errors';

// Read-only directory built from the CRM. Access-scoped: company-wide roles see all in the tenant;
// branch-scoped roles see only their branches (and users overlapping those branches).
const tenantFilter = (access: MongoAccess): Record<string, unknown> =>
  access.tenantId && Types.ObjectId.isValid(access.tenantId) ? { tenant_id: new Types.ObjectId(access.tenantId) } : {};

function mapUser(u: CrmUser, roles: Map<string, CrmRole>) {
  const r = u.role_id ? roles.get(String(u.role_id)) : undefined;
  const firstName = u.first_name ?? '';
  const lastName = u.last_name ?? '';
  return {
    id: String(u._id),
    email: u.email,
    firstName,
    lastName,
    name: `${firstName} ${lastName}`.trim() || u.email,
    phone: u.phone ?? null,
    role: r?.name ?? 'employee',
    roleId: u.role_id ? String(u.role_id) : null,
    level: r?.level ?? 5,
    status: u.status ?? null,
    branchIds: (u.branch_ids ?? []).map(String),
    position: null as string | null, // app-set job title, overlaid by listUsers/getUser
    avatar: null as string | null, // app-set profile picture url, overlaid by listUsers/getUser
    businessIds: [] as string[], // explicit business grants (kb360_app), overlaid by listUsers/getUser
  };
}
const mapCompany = (c: CrmCompany) => ({ id: String(c._id), name: c.name, status: c.status ?? null });
const mapBranch = (b: CrmBranch) => ({
  id: String(b._id),
  code: b.code ?? null,
  name: b.name ?? null,
  city: b.city ?? null,
  country: b.country ?? null,
  isHO: b.isHO ?? false,
  companyId: b.company_id ? String(b.company_id) : null,
});
async function roleMap(): Promise<Map<string, CrmRole>> {
  const roles = await crmRepo.listRoles();
  return new Map(roles.map((r) => [String(r._id), r]));
}

// The KBiz360 business keeps exactly ONE branch — its Mumbai HQ. Membership in the business =
// having that branch id in the user's branch_ids. Finds the KBiz360 company (name match,
// tenant-scoped) and creates the branch under it on first use; if the company already has any
// branch, that one is adopted. The branch code MUST NOT be 'BOM': the shared branches collection
// carries the ERP's unique index on `code` and Travkings owns BOM — creating a duplicate threw
// E11000 on every load, which is why the KBiz members screen (and group creation) never worked.
const KBIZ_BRANCH_CODE = 'KBIZ';
const squash = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');
async function ensureKbizBom(access: MongoAccess, adminId: string): Promise<{ company: CrmCompany; branch: CrmBranch }> {
  const companies = await crmRepo.listCompanies(tenantFilter(access));
  const company = companies.find((c) => squash(c.name).includes('kbiz360')) ?? companies.find((c) => squash(c.name).includes('kbiz'));
  if (!company) throw BadRequest('KBiz360 business not found — create the business first');
  const branches = await crmRepo.listBranches({ company_id: company._id });
  let branch = branches.find((b) => (b.code ?? '').trim().toUpperCase() === KBIZ_BRANCH_CODE) ?? branches[0];
  if (!branch) {
    const now = new Date();
    branch = await crmRepo.createBranch({
      tenant_id: company.tenant_id ?? null,
      company_id: company._id,
      name: 'KBiz360 – Mumbai',
      code: KBIZ_BRANCH_CODE,
      city: 'Mumbai',
      country: 'India',
      isHO: true,
      status: 'active',
      created_by: Types.ObjectId.isValid(adminId) ? new Types.ObjectId(adminId) : null,
      created_at: now,
      updated_at: now,
      __v: 0,
    });
  }
  return { company, branch };
}

export const directoryService = {
  async listUsers(access: MongoAccess, opts: { includeDisabled?: boolean } = {}) {
    const roles = await roleMap();
    const users = await crmRepo.listUsers(tenantFilter(access));
    const scoped = access.companyWide
      ? users
      : users.filter((u) => (u.branch_ids ?? []).some((b) => access.branchIds!.includes(String(b))));
    const mapped = scoped.map((u) => mapUser(u, roles));
    const ids = mapped.map((m) => m.id);
    const positions = await userPositions.mapFor(ids);
    const avatars = await userAvatars.mapFor(ids);
    const bizGrants = await userBusinessAccess.mapFor(ids);
    const result = mapped.map((m) => ({ ...m, position: positions[m.id] ?? null, avatar: avatars[m.id] ?? null, businessIds: bizGrants[m.id] ?? [] }));
    // Deactivated users (app access disabled by a super-admin) are hidden from every directory-driven
    // list — New Group members, the new-chat picker, reminders, alerts, business detail — so a
    // deactivated user never appears anywhere in the app. Only the admin "Team & Users" screen passes
    // includeDisabled to still show (and re-enable) them.
    if (opts.includeDisabled) return result;
    const disabled = await appAccess.disabledSet();
    return result.filter((u) => !disabled.has(u.id));
  },

  async getUser(access: MongoAccess, id: string) {
    const u = await crmRepo.getUserById(id);
    if (!u) return null;
    if (!access.companyWide && !(u.branch_ids ?? []).some((b) => access.branchIds!.includes(String(b)))) return null;
    const roles = await roleMap();
    const mapped = mapUser(u, roles);
    const positions = await userPositions.mapFor([mapped.id]);
    const avatars = await userAvatars.mapFor([mapped.id]);
    const bizGrants = await userBusinessAccess.mapFor([mapped.id]);
    return { ...mapped, position: positions[mapped.id] ?? null, avatar: avatars[mapped.id] ?? null, businessIds: bizGrants[mapped.id] ?? [] };
  },

  async listCompanies(access: MongoAccess) {
    const companies = await crmRepo.listCompanies(tenantFilter(access));
    if (access.companyWide) return companies.map(mapCompany);
    // Branch-scoped users see the companies they actually have a branch in, plus any business a
    // super-admin granted them explicitly (business access without branch membership).
    const ids = (access.branchIds ?? []).filter((b) => Types.ObjectId.isValid(b)).map((b) => new Types.ObjectId(b));
    const myBranches = await crmRepo.branchesByIds(ids);
    const myCompanyIds = new Set(myBranches.map((b) => (b.company_id ? String(b.company_id) : '')).filter(Boolean));
    for (const bid of await userBusinessAccess.listFor(access.userId)) myCompanyIds.add(bid);
    return companies.filter((c) => myCompanyIds.has(String(c._id))).map(mapCompany);
  },

  async listBranches(access: MongoAccess) {
    if (access.companyWide) return (await crmRepo.listBranches(tenantFilter(access))).map(mapBranch);
    const ids = (access.branchIds ?? []).filter((b) => Types.ObjectId.isValid(b)).map((b) => new Types.ObjectId(b));
    return (await crmRepo.branchesByIds(ids)).map(mapBranch);
  },

  async listRoles(access: MongoAccess) {
    const roles = await crmRepo.listRoles();
    const scoped = access.tenantId
      ? roles.filter((r) => (r.tenant_id ? String(r.tenant_id) : null) === access.tenantId)
      : roles;
    return scoped
      .sort((a, b) => a.level - b.level)
      .map((r) => ({ id: String(r._id), name: r.name, level: r.level, permissions: r.permissions ?? [] }));
  },

  // ── Deletes (super-admin). The CRM app hard-deletes these tenant-scoped, so we do the same —
  // with guards: no deleting yourself, and a business must be emptied of branches first. ──
  async deleteCompany(adminId: string, id: string) {
    const access = await accessService.accessForUserId(adminId);
    if (!access) throw Forbidden('Session user not found');
    const company = (await crmRepo.listCompanies(tenantFilter(access))).find((c) => String(c._id) === id);
    if (!company) throw BadRequest('Business not found');
    const branches = await crmRepo.listBranches({ company_id: company._id });
    if (branches.length) throw BadRequest(`"${company.name}" still has ${branches.length} branch${branches.length === 1 ? '' : 'es'} — delete them first`);
    await crmRepo.deleteCompany(id);
    return { ok: true };
  },

  async deleteBranch(adminId: string, id: string) {
    const access = await accessService.accessForUserId(adminId);
    if (!access) throw Forbidden('Session user not found');
    if (!Types.ObjectId.isValid(id)) throw BadRequest('Branch not found');
    const branch = (await crmRepo.listBranches(tenantFilter(access))).find((b) => String(b._id) === id);
    if (!branch) throw BadRequest('Branch not found');
    // Un-assign it from every user, drop its per-branch CRM department rows, then delete the branch.
    await crmRepo.pullBranchFromAllUsers(branch._id);
    await crmRepo.deleteDepartmentsWhere({ branch_id: branch._id });
    await crmRepo.deleteBranch(id);
    return { ok: true };
  },

  async deleteUser(adminId: string, id: string) {
    const access = await accessService.accessForUserId(adminId);
    if (!access) throw Forbidden('Session user not found');
    if (id === adminId) throw BadRequest('You cannot delete your own account');
    const user = await crmRepo.getUserById(id);
    if (!user) throw BadRequest('User not found');
    if (access.tenantId && user.tenant_id && String(user.tenant_id) !== access.tenantId) throw BadRequest('User not found');
    await crmRepo.deleteUser(id);
    return { ok: true };
  },

  // ── Business provisioning (writes to the CRM companies collection, mirroring the ERP's doc shape
  // so the new business shows up in both the app directory and the ERP) ──
  async createCompany(adminId: string, input: { name: string }) {
    const access = await accessService.accessForUserId(adminId);
    if (!access) throw Forbidden('Session user not found');
    const name = input.name.trim();
    if (!name) throw BadRequest('Business name is required');
    const existing = await crmRepo.listCompanies(tenantFilter(access));
    if (existing.some((c) => c.name.trim().toLowerCase() === name.toLowerCase())) {
      throw BadRequest('A business with this name already exists');
    }
    const now = new Date();
    const created = await crmRepo.createCompany({
      tenant_id: access.tenantId && Types.ObjectId.isValid(access.tenantId) ? new Types.ObjectId(access.tenantId) : null,
      name,
      status: 'active',
      created_by: Types.ObjectId.isValid(adminId) ? new Types.ObjectId(adminId) : null,
      created_at: now,
      updated_at: now,
      __v: 0,
    });
    return mapCompany(created);
  },

  // Super-admin: create a BRANCH under a specific business. Branch code is globally unique across the
  // shared branches collection (the ERP relies on that), so we validate up-front and also catch the
  // duplicate-key error in case of a race.
  async createBranch(adminId: string, input: { companyId: string; name: string; code: string; city?: string; country?: string; isHO?: boolean; userIds?: string[] }) {
    const access = await accessService.accessForUserId(adminId);
    if (!access) throw Forbidden('Session user not found');
    const name = input.name.trim();
    const code = input.code.trim().toUpperCase();
    if (!name) throw BadRequest('Branch name is required');
    if (!code) throw BadRequest('Branch code is required');
    if (!Types.ObjectId.isValid(input.companyId)) throw BadRequest('Select a business for this branch');
    // The branch must belong to a real business in the admin's scope.
    const companies = await crmRepo.listCompanies(tenantFilter(access));
    const company = companies.find((c) => String(c._id) === input.companyId);
    if (!company) throw BadRequest('Business not found — pick a valid business');
    // Codes are unique across ALL branches (shared with the ERP) — reject a clash early.
    const clash = (await crmRepo.listBranches({})).some((b) => (b.code ?? '').trim().toUpperCase() === code);
    if (clash) throw BadRequest(`Branch code "${code}" is already in use — pick another`);
    const now = new Date();
    try {
      const created = await crmRepo.createBranch({
        tenant_id: company.tenant_id ?? null,
        company_id: company._id,
        name,
        code,
        city: input.city?.trim() || null,
        country: input.country?.trim() || 'India',
        isHO: !!input.isHO,
        status: 'active',
        created_by: Types.ObjectId.isValid(adminId) ? new Types.ObjectId(adminId) : null,
        created_at: now,
        updated_at: now,
        __v: 0,
      });
      // Optional team members: add the new branch to each user's branch_ids ($addToSet — never
      // disturbs their existing memberships). Only users inside the admin's tenant scope count;
      // unknown/out-of-scope ids are skipped silently rather than failing the whole create.
      let membersAdded = 0;
      const requested = [...new Set(input.userIds ?? [])].filter((u) => Types.ObjectId.isValid(u));
      if (requested.length) {
        const inScope = new Set((await crmRepo.listUsers(tenantFilter(access))).map((u) => String(u._id)));
        for (const userId of requested) {
          if (!inScope.has(userId)) continue;
          await crmRepo.addUserBranch(userId, created._id);
          membersAdded++;
        }
      }
      return { ...mapBranch(created), membersAdded };
    } catch (e) {
      if ((e as { code?: number }).code === 11000) throw BadRequest(`Branch code "${code}" is already in use — pick another`);
      throw e;
    }
  },

  // ── User provisioning (writes to the CRM users collection so the account can log in normally) ──
  async createUser(adminId: string, input: { email: string; password: string; firstName?: string; lastName?: string; phone?: string; roleId?: string; branchIds?: string[]; businessIds?: string[] }) {
    const access = await accessService.accessForUserId(adminId);
    if (!access) throw Forbidden('Session user not found');
    const email = input.email.trim().toLowerCase();
    if (!email) throw BadRequest('Email is required');
    if (!input.password || input.password.length < 6) throw BadRequest('Password must be at least 6 characters');
    if (await crmRepo.findUserByEmail(email)) throw BadRequest('A user with this email already exists');
    const now = new Date();
    const doc: Record<string, unknown> = {
      email,
      password: await bcrypt.hash(input.password, 10),
      first_name: input.firstName?.trim() ?? '',
      last_name: input.lastName?.trim() ?? '',
      phone: input.phone?.trim() || null,
      role_id: input.roleId && Types.ObjectId.isValid(input.roleId) ? new Types.ObjectId(input.roleId) : null,
      branch_ids: (input.branchIds ?? []).filter((b) => Types.ObjectId.isValid(b)).map((b) => new Types.ObjectId(b)),
      tenant_id: access.tenantId && Types.ObjectId.isValid(access.tenantId) ? new Types.ObjectId(access.tenantId) : null,
      // A user created FROM Smart Connect is a Smart Connect user — grant app access explicitly so
      // they can sign in. The login gate (auth.ts) is deny-by-default on access.app === true, so
      // without this every app-created user is locked out with "ask an administrator to enable it".
      access: { app: true },
      status: 'active',
      email_verified: true,
      created_at: now,
      updated_at: now,
    };
    const created = await crmRepo.createUser(doc);
    if (input.businessIds?.length) await userBusinessAccess.setBusinesses(String(created._id), input.businessIds, adminId);
    return mapUser(created, await roleMap());
  },

  async updateUser(adminId: string, id: string, patch: { firstName?: string; lastName?: string; phone?: string; roleId?: string; branchIds?: string[]; businessIds?: string[]; password?: string; status?: string }) {
    const access = await accessService.accessForUserId(adminId);
    if (!access) throw Forbidden('Session user not found');
    const set: Record<string, unknown> = { updated_at: new Date() };
    if (patch.firstName !== undefined) set.first_name = patch.firstName.trim();
    if (patch.lastName !== undefined) set.last_name = patch.lastName.trim();
    if (patch.phone !== undefined) set.phone = patch.phone?.trim() || null;
    if (patch.roleId !== undefined) set.role_id = patch.roleId && Types.ObjectId.isValid(patch.roleId) ? new Types.ObjectId(patch.roleId) : null;
    if (patch.branchIds !== undefined) set.branch_ids = patch.branchIds.filter((b) => Types.ObjectId.isValid(b)).map((b) => new Types.ObjectId(b));
    if (patch.status !== undefined) set.status = patch.status;
    if (patch.password) { if (patch.password.length < 6) throw BadRequest('Password must be at least 6 characters'); set.password = await bcrypt.hash(patch.password, 10); }
    const updated = await crmRepo.updateUser(id, set);
    if (!updated) throw BadRequest('User not found');
    // Explicit business grants live app-side (kb360_app) — the CRM users collection stays untouched.
    if (patch.businessIds !== undefined) await userBusinessAccess.setBusinesses(id, patch.businessIds, adminId);
    return mapUser(updated, await roleMap());
  },

  // A user setting their OWN profile picture (url from an /api/uploads result). Pass null to clear.
  async setOwnAvatar(userId: string, url: string | null) {
    await userAvatars.setAvatar(userId, url ? url.trim() : null);
    return { avatar: url ? url.trim() : null };
  },

  // A user changing their OWN password (verifies the current one, then writes a new bcrypt hash to CRM).
  async changeOwnPassword(userId: string, currentPassword: string, newPassword: string) {
    if (!newPassword || newPassword.length < 6) throw BadRequest('New password must be at least 6 characters');
    const user = await crmRepo.getUserById(userId);
    if (!user) throw Forbidden('Session user not found');
    if (!user.password || !(await bcrypt.compare(currentPassword, user.password))) throw BadRequest('Current password is incorrect');
    await crmRepo.updateUser(userId, { password: await bcrypt.hash(newPassword, 10), updated_at: new Date() });
    return { ok: true };
  },

  // A user editing their OWN profile (name / phone only — never role/branch/status).
  async updateOwnProfile(userId: string, patch: { firstName?: string; lastName?: string; phone?: string }) {
    const set: Record<string, unknown> = { updated_at: new Date() };
    if (patch.firstName !== undefined) set.first_name = patch.firstName.trim();
    if (patch.lastName !== undefined) set.last_name = patch.lastName.trim();
    if (patch.phone !== undefined) set.phone = patch.phone?.trim() || null;
    const updated = await crmRepo.updateUser(userId, set);
    if (!updated) throw BadRequest('User not found');
    return mapUser(updated, await roleMap());
  },

  // ── KBiz360 · BOM membership (super-admin, profile → "KBiz360 Members") ──
  // Every tenant user with a `member` flag: is the BOM branch in their branch_ids? Ensures the
  // KBiz360 company has its single BOM branch (created on first call).
  async kbizMembership(adminId: string) {
    const access = await accessService.accessForUserId(adminId);
    if (!access) throw Forbidden('Session user not found');
    const { company, branch } = await ensureKbizBom(access, adminId);
    const bomId = String(branch._id);
    const roles = await roleMap();
    const users = await crmRepo.listUsers(tenantFilter(access));
    const mapped = users.map((u) => ({ ...mapUser(u, roles), member: (u.branch_ids ?? []).some((b) => String(b) === bomId) }));
    const ids = mapped.map((m) => m.id);
    const positions = await userPositions.mapFor(ids);
    const avatars = await userAvatars.mapFor(ids);
    return {
      company: mapCompany(company),
      branch: mapBranch(branch),
      users: mapped.map((m) => ({ ...m, position: positions[m.id] ?? null, avatar: avatars[m.id] ?? null })),
    };
  },

  async setKbizMembership(adminId: string, userId: string, member: boolean) {
    const access = await accessService.accessForUserId(adminId);
    if (!access) throw Forbidden('Session user not found');
    const { branch } = await ensureKbizBom(access, adminId);
    const user = await crmRepo.getUserById(userId);
    if (!user) throw BadRequest('User not found');
    if (member) await crmRepo.addUserBranch(userId, branch._id);
    else await crmRepo.removeUserBranch(userId, branch._id);
    return { id: userId, member };
  },

  async setRolePermissions(adminId: string, roleId: string, permissions: string[]) {
    const access = await accessService.accessForUserId(adminId);
    if (!access) throw Forbidden('Session user not found');
    const role = await crmRepo.setRolePermissions(roleId, permissions);
    if (!role) throw BadRequest('Role not found');
    return { id: String(role._id), name: role.name, level: role.level, permissions: role.permissions ?? [] };
  },
};
