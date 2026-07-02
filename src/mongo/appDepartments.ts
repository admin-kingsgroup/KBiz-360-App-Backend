import { Types } from 'mongoose';
import { appDb } from './connection';

// App-created DEPARTMENTS, managed by super-admins. The CRM (`test` db) is READ-ONLY, so departments
// added/edited in-app live here in kb360_app and are merged into the directory. A department belongs to
// a company and applies to all its branches (so each branch gets that department's group), unless a
// specific branchId is set. Soft-deleted via active:false.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const col = () => appDb().collection('app_departments') as any;
const oid = (id: string) => new Types.ObjectId(id);

export interface AppDepartmentDoc {
  _id?: Types.ObjectId;
  name: string;
  companyId: string | null;
  branchId: string | null; // null = all branches in the company
  icon: string | null;
  color: string | null;
  active: boolean;
  tenantId: string | null;
  createdBy: string | null;
  createdAt?: Date;
  updatedAt?: Date;
}

export const appDepartments = {
  listByTenant: (tenantId: string | null): Promise<AppDepartmentDoc[]> =>
    col().find({ active: { $ne: false }, ...(tenantId ? { tenantId } : {}) }).toArray(),

  byId: (id: string): Promise<AppDepartmentDoc | null> =>
    Types.ObjectId.isValid(id) ? col().findOne({ _id: oid(id) }) : Promise.resolve(null),

  async create(doc: Omit<AppDepartmentDoc, '_id' | 'active' | 'createdAt' | 'updatedAt'>): Promise<AppDepartmentDoc> {
    const now = new Date();
    const res = await col().insertOne({ ...doc, active: true, createdAt: now, updatedAt: now });
    return col().findOne({ _id: res.insertedId });
  },

  async update(id: string, set: Partial<AppDepartmentDoc>): Promise<AppDepartmentDoc | null> {
    if (!Types.ObjectId.isValid(id)) return null;
    await col().updateOne({ _id: oid(id) }, { $set: { ...set, updatedAt: new Date() } });
    return col().findOne({ _id: oid(id) });
  },

  async remove(id: string): Promise<{ ok: boolean }> {
    if (Types.ObjectId.isValid(id)) await col().updateOne({ _id: oid(id) }, { $set: { active: false, updatedAt: new Date() } });
    return { ok: true };
  },
};
