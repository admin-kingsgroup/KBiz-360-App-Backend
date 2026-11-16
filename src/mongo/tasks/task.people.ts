import { Types } from 'mongoose';
import { crmRepo, type CrmUser } from '../crm.repo';
import { DEFAULT_TZ, tzForBranchCode } from './task.time';

// Who a user is, for tasks: display name, email, role level and branches (hierarchy visibility), and
// the time zone their dates and quiet hours are read in (their first branch's zone).
export interface TaskPerson {
  id: string;
  name: string;
  email: string;
  level: number; // 1 super_admin … 5 employee
  branchIds: string[];
  tz: string;
}

const nameOf = (u: CrmUser): string => `${u.first_name ?? ''} ${u.last_name ?? ''}`.trim() || u.email || 'Unknown';

export const taskPeople = {
  async resolve(ids: string[]): Promise<Map<string, TaskPerson>> {
    const out = new Map<string, TaskPerson>();
    const oids = [...new Set(ids)].filter((id) => Types.ObjectId.isValid(id)).map((id) => new Types.ObjectId(id));
    if (!oids.length) return out;
    const users = await crmRepo.listUsers({ _id: { $in: oids } });
    const roleIds = [...new Set(users.map((u) => (u.role_id ? String(u.role_id) : '')).filter(Boolean))];
    const roles = new Map<string, number>();
    await Promise.all(roleIds.map(async (rid) => { const r = await crmRepo.getRoleById(rid); if (r) roles.set(rid, r.level ?? 5); }));
    const firstBranchIds = [...new Set(users.map((u) => (u.branch_ids?.[0] ? String(u.branch_ids[0]) : '')).filter(Boolean))];
    const branches = firstBranchIds.length ? await crmRepo.branchesByIds(firstBranchIds.map((b) => new Types.ObjectId(b))) : [];
    const codeOf = new Map(branches.map((b) => [String(b._id), b.code ?? null]));
    for (const u of users) {
      const id = String(u._id);
      const first = u.branch_ids?.[0] ? String(u.branch_ids[0]) : null;
      out.set(id, {
        id,
        name: nameOf(u),
        email: u.email ?? '',
        level: u.role_id ? roles.get(String(u.role_id)) ?? 5 : 5,
        branchIds: (u.branch_ids ?? []).map(String),
        tz: first ? tzForBranchCode(codeOf.get(first)) : DEFAULT_TZ,
      });
    }
    return out;
  },
  async one(id: string): Promise<TaskPerson | null> {
    return (await this.resolve([id])).get(id) ?? null;
  },
};

export const unknownPerson = (id: string): TaskPerson => ({ id, name: 'Unknown', email: '', level: 5, branchIds: [], tz: DEFAULT_TZ });
