import 'dotenv/config';
import * as bcrypt from 'bcryptjs';
import { connectMongo, disconnectMongo } from '../src/mongo/connection';
import { crmRepo } from '../src/mongo/crm.repo';

// One-off: provision a CRM user with super-admin rights (role level 1). Credentials come from env
// (NEW_EMAIL / NEW_PASS / NEW_FIRST / NEW_LAST) so nothing sensitive is written into this file.
// Mirrors directoryService.createUser's document shape, and anchors tenant + role to an existing
// super admin so the account lands in the right tenant. Refuses to overwrite an existing email.
async function main(): Promise<void> {
  const email = (process.env.NEW_EMAIL ?? '').trim().toLowerCase();
  const password = process.env.NEW_PASS ?? '';
  const firstName = (process.env.NEW_FIRST ?? '').trim();
  const lastName = (process.env.NEW_LAST ?? '').trim();
  if (!email || !password) throw new Error('NEW_EMAIL and NEW_PASS are required');
  if (password.length < 6) throw new Error('Password must be at least 6 characters');

  await connectMongo();

  const existing = await crmRepo.findUserByEmail(email);
  if (existing) {
    const r = existing.role_id ? await crmRepo.getRoleById(existing.role_id) : null;
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ status: 'EXISTS_NO_CHANGE', id: String(existing._id), email: existing.email, role: r?.name ?? null, level: r?.level ?? null, userStatus: existing.status ?? null }, null, 2));
    await disconnectMongo();
    return;
  }

  // Super-admin role(s): level 1 or name super_admin. Anchor the tenant/role to an existing super user.
  const roles = await crmRepo.listRoles();
  const superRoles = roles.filter((r) => r.level === 1 || r.name === 'super_admin');
  if (!superRoles.length) throw new Error('No super_admin role (level 1) found in CRM roles');

  const allUsers = await crmRepo.listUsers();
  const anchor = allUsers.find((u) => u.role_id && superRoles.some((r) => String(r._id) === String(u.role_id)));
  let role = superRoles[0];
  const tenantId = anchor?.tenant_id ?? superRoles[0].tenant_id ?? null;
  if (anchor?.role_id) {
    const ar = superRoles.find((r) => String(r._id) === String(anchor.role_id));
    if (ar) role = ar;
  } else if (tenantId) {
    const tr = superRoles.find((r) => String(r.tenant_id) === String(tenantId));
    if (tr) role = tr;
  }

  const now = new Date();
  const doc: Record<string, unknown> = {
    email,
    password: await bcrypt.hash(password, 10),
    first_name: firstName,
    last_name: lastName,
    phone: null,
    role_id: role._id,
    branch_ids: [], // super admin is companyWide → sees all branches regardless
    tenant_id: tenantId,
    status: 'active',
    email_verified: true,
    created_at: now,
    updated_at: now,
  };
  const created = await crmRepo.createUser(doc);
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ status: 'CREATED', id: String(created._id), email: created.email, role: role.name, level: role.level, tenantId: tenantId ? String(tenantId) : null, anchoredTo: anchor ? anchor.email : '(none — first super role)' }, null, 2));
  await disconnectMongo();
}

main().catch((e) => { /* eslint-disable-next-line no-console */ console.error('ERROR:', (e as Error).message); process.exit(1); });
