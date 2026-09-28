import { Types } from 'mongoose';
import { crmRepo, type CrmUser } from '../crm.repo';

// Who has ERP (KBiz360 Books) access — the ERP's own rule (kbiz360-erp-backend
// features/user-access/userAccess.controller `erpAccess`): an ACTIVE `booksaccesses` row for the
// user's email AND `access.erp !== false` on the shared user (the ERP's kill-switch). ERP and ERP
// Reports alerts reach only these people (alertChannels.needsErpAccess).
type ErpUser = Pick<CrmUser, '_id' | 'email' | 'access'>;

export function erpAccessIdsFrom(users: ErpUser[], activeEmails: Iterable<string>): Set<string> {
  const active = new Set([...activeEmails].map((e) => String(e).toLowerCase().trim()));
  return new Set(users
    .filter((u) => u.access?.erp !== false && active.has(String(u.email ?? '').toLowerCase().trim()))
    .map((u) => String(u._id)));
}

export async function erpAccessIds(users: ErpUser[]): Promise<Set<string>> {
  if (!users.length) return new Set();
  return erpAccessIdsFrom(users, await crmRepo.activeBooksAccessEmails(users.map((u) => u.email)));
}

export async function erpAccessIdsFor(userIds: string[]): Promise<Set<string>> {
  const ids = userIds.filter((id) => Types.ObjectId.isValid(id)).map((id) => new Types.ObjectId(id));
  if (!ids.length) return new Set();
  return erpAccessIds(await crmRepo.listUsers({ _id: { $in: ids } }));
}
