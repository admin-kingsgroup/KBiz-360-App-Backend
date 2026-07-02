import { Types } from 'mongoose';
import { crmDb } from './connection';

// Shapes of the CRM collections we READ (only the fields we use). Read-only — no write models.
export interface CrmUser {
  _id: Types.ObjectId;
  tenant_id?: Types.ObjectId;
  role_id?: Types.ObjectId;
  email: string;
  password?: string; // bcrypt
  first_name?: string;
  last_name?: string;
  phone?: string;
  status?: string;
  email_verified?: boolean;
  branch_ids?: Types.ObjectId[];
  last_login_at?: Date;
  // Per-app login toggles set from the ERP (Settings → Users & Roles → App Access).
  // Absent/true = allowed; `app === false` blocks login to KBiz360 Smart Connect.
  access?: { crm?: boolean; erp?: boolean; app?: boolean };
}
export interface CrmRole {
  _id: Types.ObjectId;
  tenant_id?: Types.ObjectId;
  name: string;
  level: number;
  permissions?: string[];
  is_system?: boolean;
}
export interface CrmCompany {
  _id: Types.ObjectId;
  tenant_id?: Types.ObjectId;
  name: string;
  status?: string;
}
export interface CrmBranch {
  _id: Types.ObjectId;
  tenant_id?: Types.ObjectId;
  company_id?: Types.ObjectId;
  name?: string;
  code?: string;
  city?: string;
  country?: string;
  isHO?: boolean;
  status?: string;
}
export interface CrmDepartment {
  _id: Types.ObjectId;
  tenant_id?: Types.ObjectId;
  company_id?: Types.ObjectId;
  branch_id?: Types.ObjectId;
  name?: string;
  code?: string;
  status?: string;
}

const oid = (id: string): Types.ObjectId | null => (Types.ObjectId.isValid(id) ? new Types.ObjectId(id) : null);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const col = (name: string) => crmDb().collection(name) as any;

export const crmRepo = {
  async findUserByEmail(email: string): Promise<CrmUser | null> {
    return col('users').findOne({ email: email.toLowerCase().trim() }) as Promise<CrmUser | null>;
  },
  async getUserById(id: string): Promise<CrmUser | null> {
    const _id = oid(id);
    return _id ? (col('users').findOne({ _id }) as Promise<CrmUser | null>) : null;
  },
  async listUsers(filter: Record<string, unknown> = {}): Promise<CrmUser[]> {
    return col('users').find(filter).toArray() as Promise<CrmUser[]>;
  },
  async listRoles(): Promise<CrmRole[]> {
    return col('roles').find({}).toArray() as Promise<CrmRole[]>;
  },
  async getRoleById(id?: Types.ObjectId | string | null): Promise<CrmRole | null> {
    if (!id) return null;
    const _id = typeof id === 'string' ? oid(id) : id;
    return _id ? (col('roles').findOne({ _id }) as Promise<CrmRole | null>) : null;
  },
  async listCompanies(filter: Record<string, unknown> = {}): Promise<CrmCompany[]> {
    return col('companies').find(filter).toArray() as Promise<CrmCompany[]>;
  },
  async getCompanyById(id: string): Promise<CrmCompany | null> {
    const _id = oid(id);
    return _id ? (col('companies').findOne({ _id }) as Promise<CrmCompany | null>) : null;
  },
  async listBranches(filter: Record<string, unknown> = {}): Promise<CrmBranch[]> {
    return col('branches').find(filter).toArray() as Promise<CrmBranch[]>;
  },
  async branchesByIds(ids: Types.ObjectId[]): Promise<CrmBranch[]> {
    if (!ids?.length) return [];
    return col('branches').find({ _id: { $in: ids } }).toArray() as Promise<CrmBranch[]>;
  },
  async listDepartments(filter: Record<string, unknown> = {}): Promise<CrmDepartment[]> {
    return col('departments').find(filter).toArray() as Promise<CrmDepartment[]>;
  },

  // ── WRITES (user provisioning — explicitly authorized to write to the CRM users collection) ──
  async createUser(doc: Record<string, unknown>): Promise<CrmUser> {
    const res = await col('users').insertOne(doc);
    return col('users').findOne({ _id: res.insertedId }) as Promise<CrmUser>;
  },
  async updateUser(id: string, set: Record<string, unknown>): Promise<CrmUser | null> {
    const _id = oid(id);
    if (!_id) return null;
    await col('users').updateOne({ _id }, { $set: set });
    return col('users').findOne({ _id }) as Promise<CrmUser | null>;
  },
  async setRolePermissions(id: string, permissions: string[]): Promise<CrmRole | null> {
    const _id = oid(id);
    if (!_id) return null;
    await col('roles').updateOne({ _id }, { $set: { permissions } });
    return col('roles').findOne({ _id }) as Promise<CrmRole | null>;
  },
};
