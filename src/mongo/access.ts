import { crmRepo, type CrmRole, type CrmUser } from './crm.repo';

// Real authorization model (from the CRM): 5 roles by numeric level + branch_ids + tenant/company.
// "Director", "GM", etc. are DESIGNATIONS (display-only) — they do not affect access.
export type RoleName = 'super_admin' | 'company_manager' | 'branch_manager' | 'hod' | 'employee';

export interface MongoAccess {
  userId: string;
  tenantId: string | null;
  roleName: string;
  level: number; // 1=super_admin … 5=employee
  isSuper: boolean; // level === 1 (or '*' permission)
  canManage: boolean; // super_admin OR company_manager (level <= 2)
  companyWide: boolean; // sees all branches in the company/tenant (super_admin or company_manager)
  branchIds: string[] | null; // null = all branches (super_admin/company_manager); else assigned
  permissions: string[];
  // System-alert channel grants ("BOM-hr"…), super-admin managed (kb360_app.alert_grants).
  // Populated by auth login/me — not by deriveAccess (which stays free of DB I/O).
  alerts?: string[];
}

// Pure derivation from a CRM user + their role. No DB I/O.
export function deriveAccess(user: CrmUser, role: CrmRole | null): MongoAccess {
  const level = role?.level ?? 5;
  const roleName = role?.name ?? 'employee';
  const permissions = role?.permissions ?? [];
  const isSuper = level === 1 || permissions.includes('*');
  const companyWide = level <= 2; // super_admin + company_manager see the whole company/tenant
  return {
    userId: String(user._id),
    tenantId: user.tenant_id ? String(user.tenant_id) : null,
    roleName,
    level,
    isSuper,
    canManage: level <= 2,
    companyWide,
    branchIds: companyWide ? null : (user.branch_ids ?? []).map(String),
    permissions,
  };
}

export const accessService = {
  async accessForUser(user: CrmUser): Promise<MongoAccess> {
    const role = await crmRepo.getRoleById(user.role_id ?? null);
    return deriveAccess(user, role);
  },
  async accessForUserId(id: string): Promise<MongoAccess | null> {
    const user = await crmRepo.getUserById(id);
    if (!user) return null;
    return this.accessForUser(user);
  },
  // Branch visibility: company-wide roles see all; others only their assigned branch ids.
  branchOK(access: MongoAccess, branchId: string): boolean {
    return access.branchIds === null || access.branchIds.includes(branchId);
  },
  // Reminder/chain-of-command visibility: strictly-lower level, scoped by branch overlap.
  canSee(viewer: MongoAccess, target: { level: number; branchIds: string[] }): boolean {
    if (target.level <= viewer.level) return false; // only strictly below
    if (viewer.companyWide) return true; // super_admin / company_manager → whole company
    const mine = viewer.branchIds ?? [];
    return target.branchIds.some((b) => mine.includes(b)); // branch overlap
  },
};
