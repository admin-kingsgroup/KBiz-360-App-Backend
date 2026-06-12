import { Types } from 'mongoose';
import { crmRepo, type CrmBranch, type CrmCompany, type CrmDepartment, type CrmRole, type CrmUser } from './crm.repo';
import type { MongoAccess } from './access';

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
    level: r?.level ?? 5,
    status: u.status ?? null,
    branchIds: (u.branch_ids ?? []).map(String),
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
});

async function roleMap(): Promise<Map<string, CrmRole>> {
  const roles = await crmRepo.listRoles();
  return new Map(roles.map((r) => [String(r._id), r]));
}

export const directoryService = {
  async listUsers(access: MongoAccess) {
    const roles = await roleMap();
    const users = await crmRepo.listUsers(tenantFilter(access));
    const scoped = access.companyWide
      ? users
      : users.filter((u) => (u.branch_ids ?? []).some((b) => access.branchIds!.includes(String(b))));
    return scoped.map((u) => mapUser(u, roles));
  },

  async getUser(access: MongoAccess, id: string) {
    const u = await crmRepo.getUserById(id);
    if (!u) return null;
    if (!access.companyWide && !(u.branch_ids ?? []).some((b) => access.branchIds!.includes(String(b)))) return null;
    const roles = await roleMap();
    return mapUser(u, roles);
  },

  async listCompanies(access: MongoAccess) {
    return (await crmRepo.listCompanies(tenantFilter(access))).map(mapCompany);
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
    return scoped.map(mapDept);
  },
};
