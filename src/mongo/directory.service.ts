import { Types } from 'mongoose';
import * as bcrypt from 'bcryptjs';
import { crmRepo, type CrmBranch, type CrmCompany, type CrmDepartment, type CrmRole, type CrmUser } from './crm.repo';
import { userPositions } from './userPositions';
import { userAvatars } from './userAvatars';
import { appDepartments } from './appDepartments';
import { accessService, type MongoAccess } from './access';
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
const mapDept = (d: CrmDepartment) => ({
  id: String(d._id),
  name: d.name ?? null,
  code: d.code ?? null,
  branchId: d.branch_id ? String(d.branch_id) : null,
  companyId: d.company_id ? String(d.company_id) : null,
  icon: null as string | null,
  color: null as string | null,
  appOwned: false, // CRM department (read-only)
});

async function roleMap(): Promise<Map<string, CrmRole>> {
  const roles = await crmRepo.listRoles();
  return new Map(roles.map((r) => [String(r._id), r]));
}

// The KBiz360 business keeps exactly ONE branch — BOM. Membership in the business = having that
// branch id in the user's branch_ids. Finds the KBiz360 company (name match, tenant-scoped) and
// creates the BOM branch under it on first use; existing extra branches are left untouched.
const squash = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');
async function ensureKbizBom(access: MongoAccess, adminId: string): Promise<{ company: CrmCompany; branch: CrmBranch }> {
  const companies = await crmRepo.listCompanies(tenantFilter(access));
  const company = companies.find((c) => squash(c.name).includes('kbiz360')) ?? companies.find((c) => squash(c.name).includes('kbiz'));
  if (!company) throw BadRequest('KBiz360 business not found — create the business first');
  const branches = await crmRepo.listBranches({ company_id: company._id });
  let branch = branches.find((b) => (b.code ?? '').trim().toUpperCase() === 'BOM' || (b.name ?? '').trim().toUpperCase() === 'BOM');
  if (!branch) {
    const now = new Date();
    branch = await crmRepo.createBranch({
      tenant_id: company.tenant_id ?? null,
      company_id: company._id,
      name: 'BOM',
      code: 'BOM',
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
  async listUsers(access: MongoAccess) {
    const roles = await roleMap();
    const users = await crmRepo.listUsers(tenantFilter(access));
    const scoped = access.companyWide
      ? users
      : users.filter((u) => (u.branch_ids ?? []).some((b) => access.branchIds!.includes(String(b))));
    const mapped = scoped.map((u) => mapUser(u, roles));
    const ids = mapped.map((m) => m.id);
    const positions = await userPositions.mapFor(ids);
    const avatars = await userAvatars.mapFor(ids);
    return mapped.map((m) => ({ ...m, position: positions[m.id] ?? null, avatar: avatars[m.id] ?? null }));
  },

  async getUser(access: MongoAccess, id: string) {
    const u = await crmRepo.getUserById(id);
    if (!u) return null;
    if (!access.companyWide && !(u.branch_ids ?? []).some((b) => access.branchIds!.includes(String(b)))) return null;
    const roles = await roleMap();
    const mapped = mapUser(u, roles);
    const positions = await userPositions.mapFor([mapped.id]);
    const avatars = await userAvatars.mapFor([mapped.id]);
    return { ...mapped, position: positions[mapped.id] ?? null, avatar: avatars[mapped.id] ?? null };
  },

  async listCompanies(access: MongoAccess) {
    const companies = await crmRepo.listCompanies(tenantFilter(access));
    if (access.companyWide) return companies.map(mapCompany);
    // Branch-scoped users only see the companies they actually have a branch in.
    const ids = (access.branchIds ?? []).filter((b) => Types.ObjectId.isValid(b)).map((b) => new Types.ObjectId(b));
    const myBranches = await crmRepo.branchesByIds(ids);
    const myCompanyIds = new Set(myBranches.map((b) => (b.company_id ? String(b.company_id) : '')).filter(Boolean));
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

  async listDepartments(access: MongoAccess, branchId?: string) {
    const filter: Record<string, unknown> = { ...tenantFilter(access) };
    if (branchId && Types.ObjectId.isValid(branchId)) filter.branch_id = new Types.ObjectId(branchId);
    const depts = await crmRepo.listDepartments(filter);
    const scoped = access.companyWide
      ? depts
      : depts.filter((d) => (d.branch_id ? access.branchIds!.includes(String(d.branch_id)) : false));
    const crmMapped = scoped.map(mapDept);

    // Merge app-created departments, expanding company-wide ones across the company's (in-scope) branches
    // so each branch gets the department's group — exactly like a CRM department.
    const branches = access.companyWide
      ? await crmRepo.listBranches(tenantFilter(access))
      : await crmRepo.branchesByIds((access.branchIds ?? []).filter((b) => Types.ObjectId.isValid(b)).map((b) => new Types.ObjectId(b)));
    const apps = await appDepartments.listByTenant(access.tenantId);
    const appExpanded = apps.flatMap((a) => {
      const targets = branches.filter((b) => {
        if (a.companyId && String(b.company_id) !== a.companyId) return false;
        if (a.branchId && String(b._id) !== a.branchId) return false;
        if (branchId && String(b._id) !== branchId) return false;
        return true;
      });
      return targets.map((b) => ({
        id: String(a._id), // same id across branches; deptKey "<branchId>:<id>" stays unique per branch
        name: a.name,
        code: null as string | null,
        branchId: String(b._id),
        companyId: a.companyId,
        icon: a.icon ?? null,
        color: a.color ?? null,
        appOwned: true,
      }));
    });
    return [...crmMapped, ...appExpanded];
  },

  // Super-admin: raw app-created departments (un-expanded) for the management screen.
  async listAppDepartments(access: MongoAccess) {
    const apps = await appDepartments.listByTenant(access.tenantId);
    return apps.map((a) => ({
      id: String(a._id),
      name: a.name,
      companyId: a.companyId ?? null,
      branchId: a.branchId ?? null,
      icon: a.icon ?? null,
      color: a.color ?? null,
    }));
  },

  // Super-admin department management (app-created departments live in kb360_app; CRM is read-only).
  async createDepartment(userId: string, input: { name: string; companyId: string | null; branchId?: string | null; icon?: string | null; color?: string | null }) {
    const access = await accessService.accessForUserId(userId);
    if (!access) throw Forbidden('Session user not found');
    return appDepartments.create({
      name: input.name.trim(),
      companyId: input.companyId ?? null,
      branchId: input.branchId ?? null,
      icon: input.icon ?? null,
      color: input.color ?? null,
      tenantId: access.tenantId,
      createdBy: userId,
    });
  },
  async updateDepartment(_userId: string, id: string, patch: { name?: string; companyId?: string | null; branchId?: string | null; icon?: string | null; color?: string | null }) {
    const set: Partial<{ name: string; companyId: string | null; branchId: string | null; icon: string | null; color: string | null }> = {};
    if (patch.name !== undefined) set.name = patch.name.trim();
    if (patch.companyId !== undefined) set.companyId = patch.companyId;
    if (patch.branchId !== undefined) set.branchId = patch.branchId;
    if (patch.icon !== undefined) set.icon = patch.icon;
    if (patch.color !== undefined) set.color = patch.color;
    return appDepartments.update(id, set);
  },
  async deleteDepartment(_userId: string, id: string) {
    return appDepartments.remove(id);
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

  // ── User provisioning (writes to the CRM users collection so the account can log in normally) ──
  async createUser(adminId: string, input: { email: string; password: string; firstName?: string; lastName?: string; phone?: string; roleId?: string; branchIds?: string[] }) {
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
      status: 'active',
      email_verified: true,
      created_at: now,
      updated_at: now,
    };
    const created = await crmRepo.createUser(doc);
    return mapUser(created, await roleMap());
  },

  async updateUser(adminId: string, id: string, patch: { firstName?: string; lastName?: string; phone?: string; roleId?: string; branchIds?: string[]; password?: string; status?: string }) {
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
