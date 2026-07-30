import { Types } from 'mongoose';
import { crmDb, crmWriteDb } from './connection';

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

// The CRM is READ-ONLY from this app. `guardReadOnly` wraps a collection so any write op throws
// instead of silently mutating the shared CRM/ERP source-of-truth — a defence that holds even if the
// DB credential still allows writes. The few sanctioned provisioning writes bypass it via `writeCol`.
const CRM_WRITE_METHODS = new Set([
  'insertOne', 'insertMany', 'updateOne', 'updateMany', 'replaceOne',
  'deleteOne', 'deleteMany', 'findOneAndUpdate', 'findOneAndReplace', 'findOneAndDelete',
  'findOneAndModify', 'bulkWrite', 'drop', 'rename',
  'createIndex', 'createIndexes', 'dropIndex', 'dropIndexes', 'insert', 'update', 'remove', 'save',
]);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function guardReadOnly(collection: any): any {
  return new Proxy(collection, {
    get(target, prop, receiver) {
      if (typeof prop === 'string' && CRM_WRITE_METHODS.has(prop)) {
        return () => {
          throw new Error(
            `CRM is read-only from this app — refused '${prop}' on a CRM collection. ` +
              'Sanctioned provisioning writes must use crmRepo write methods (crmWriteDb).',
          );
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

// READ-ONLY CRM access (write ops throw). Used by every read below.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const col = (name: string) => guardReadOnly(crmDb().collection(name)) as any;
// SANCTIONED CRM WRITE access — the only place CRM writes are allowed (user/branch/role provisioning).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const writeCol = (name: string) => crmWriteDb().collection(name) as any;

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

  // ── WRITES (user provisioning — the ONLY sanctioned CRM writes; routed through crmWriteDb) ──
  async createUser(doc: Record<string, unknown>): Promise<CrmUser> {
    const res = await writeCol('users').insertOne(doc);
    return writeCol('users').findOne({ _id: res.insertedId }) as Promise<CrmUser>;
  },
  async updateUser(id: string, set: Record<string, unknown>): Promise<CrmUser | null> {
    const _id = oid(id);
    if (!_id) return null;
    await writeCol('users').updateOne({ _id }, { $set: set });
    return writeCol('users').findOne({ _id }) as Promise<CrmUser | null>;
  },
  async createCompany(doc: Record<string, unknown>): Promise<CrmCompany> {
    const res = await writeCol('companies').insertOne(doc);
    return writeCol('companies').findOne({ _id: res.insertedId }) as Promise<CrmCompany>;
  },
  async createBranch(doc: Record<string, unknown>): Promise<CrmBranch> {
    const res = await writeCol('branches').insertOne(doc);
    return writeCol('branches').findOne({ _id: res.insertedId }) as Promise<CrmBranch>;
  },
  // Membership toggles: add/remove one branch id on a user without touching the rest of the array.
  async addUserBranch(userId: string, branchId: Types.ObjectId): Promise<void> {
    const _id = oid(userId);
    if (!_id) return;
    await writeCol('users').updateOne({ _id }, { $addToSet: { branch_ids: branchId }, $set: { updated_at: new Date() } });
  },
  async removeUserBranch(userId: string, branchId: Types.ObjectId): Promise<void> {
    const _id = oid(userId);
    if (!_id) return;
    await writeCol('users').updateOne({ _id }, { $pull: { branch_ids: branchId }, $set: { updated_at: new Date() } });
  },
  async setRolePermissions(id: string, permissions: string[]): Promise<CrmRole | null> {
    const _id = oid(id);
    if (!_id) return null;
    await writeCol('roles').updateOne({ _id }, { $set: { permissions } });
    return writeCol('roles').findOne({ _id }) as Promise<CrmRole | null>;
  },

  // ── DELETES (super-admin provisioning teardown). The CRM app itself hard-deletes these
  // tenant-scoped (company/branch/department/user *.service.js deleteOne), so we mirror that —
  // the guards (tenant scope, self-delete, company-empty) live in directory.service. ──
  async deleteUser(id: string): Promise<boolean> {
    const _id = oid(id);
    if (!_id) return false;
    return (await writeCol('users').deleteOne({ _id })).deletedCount === 1;
  },
  async deleteCompany(id: string): Promise<boolean> {
    const _id = oid(id);
    if (!_id) return false;
    return (await writeCol('companies').deleteOne({ _id })).deletedCount === 1;
  },
  async deleteBranch(id: string): Promise<boolean> {
    const _id = oid(id);
    if (!_id) return false;
    return (await writeCol('branches').deleteOne({ _id })).deletedCount === 1;
  },
  // Un-assign a branch from every user that carries it (used before deleting the branch).
  async pullBranchFromAllUsers(branchId: Types.ObjectId): Promise<void> {
    await writeCol('users').updateMany(
      { branch_ids: branchId },
      { $pull: { branch_ids: branchId }, $set: { updated_at: new Date() } },
    );
  },
  // Departments are per-branch rows expanded company-wide at read time, so deleting "one"
  // department means deleting every row of that (company, name) — hence deleteMany by filter.
  async deleteDepartmentsWhere(filter: Record<string, unknown>): Promise<number> {
    return (await writeCol('departments').deleteMany(filter)).deletedCount ?? 0;
  },
};
