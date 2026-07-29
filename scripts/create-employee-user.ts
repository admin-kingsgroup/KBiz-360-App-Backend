import 'dotenv/config';
import * as bcrypt from 'bcryptjs';
import { connectMongo, disconnectMongo } from '../src/mongo/connection';
import { crmRepo } from '../src/mongo/crm.repo';

// One-off: provision an employee-role user in a given branch. Mirrors directoryService.createUser's
// document shape (tenant stamp + access.app so the login gate lets them in). Credentials come from
// env (NEW_EMAIL / NEW_PASS / NEW_FIRST / NEW_LAST / NEW_ROLE / NEW_BRANCH). Refuses to overwrite
// an existing email. Set APPLY=1 to write; default is a dry-run that only reports what it found.
async function main(): Promise<void> {
  const email = (process.env.NEW_EMAIL ?? '').trim().toLowerCase();
  const password = process.env.NEW_PASS ?? '';
  const firstName = (process.env.NEW_FIRST ?? '').trim();
  const lastName = (process.env.NEW_LAST ?? '').trim();
  const roleName = (process.env.NEW_ROLE ?? 'employee').trim().toLowerCase();
  const branchCode = (process.env.NEW_BRANCH ?? '').trim().toUpperCase();
  const apply = process.env.APPLY === '1';
  if (!email || !password) throw new Error('NEW_EMAIL and NEW_PASS are required');
  if (password.length < 6) throw new Error('Password must be at least 6 characters');
  if (!branchCode) throw new Error('NEW_BRANCH (branch code) is required');

  await connectMongo();

  const existing = await crmRepo.findUserByEmail(email);
  if (existing) {
    const r = existing.role_id ? await crmRepo.getRoleById(existing.role_id) : null;
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ status: 'EXISTS_NO_CHANGE', id: String(existing._id), email: existing.email, role: r?.name ?? null, userStatus: existing.status ?? null }, null, 2));
    await disconnectMongo();
    return;
  }

  const roles = await crmRepo.listRoles();
  const role = roles.find((r) => (r.name ?? '').toLowerCase() === roleName);
  if (!role) throw new Error(`Role "${roleName}" not found. Available: ${roles.map((r) => r.name).join(', ')}`);

  const branches = await crmRepo.listBranches();
  const branch = branches.find((b) => ((b as { code?: string }).code ?? '').toUpperCase() === branchCode);
  if (!branch) throw new Error(`Branch "${branchCode}" not found. Available: ${branches.map((b) => (b as { code?: string }).code).join(', ')}`);

  // Tenant stamp: prefer the role's tenant, else the branch's, else anchor to any tenant-stamped user.
  let tenantId = role.tenant_id ?? (branch as { tenant_id?: unknown }).tenant_id ?? null;
  if (!tenantId) {
    const anchor = (await crmRepo.listUsers()).find((u) => u.tenant_id);
    tenantId = anchor?.tenant_id ?? null;
  }
  if (!tenantId) throw new Error('Could not resolve a tenant_id — refusing to create a tenant-less (invisible) user');

  const plan = {
    email,
    role: { id: String(role._id), name: role.name, level: role.level ?? null },
    branch: { id: String(branch._id), code: branchCode, name: (branch as { name?: string }).name ?? null },
    tenantId: String(tenantId),
    access: { app: true },
  };
  if (!apply) {
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ status: 'DRY_RUN', plan }, null, 2));
    await disconnectMongo();
    return;
  }

  const now = new Date();
  const created = await crmRepo.createUser({
    email,
    password: await bcrypt.hash(password, 10),
    first_name: firstName,
    last_name: lastName,
    phone: null,
    role_id: role._id,
    branch_ids: [branch._id],
    tenant_id: tenantId,
    access: { app: true },
    status: 'active',
    email_verified: true,
    created_at: now,
    updated_at: now,
  });
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ status: 'CREATED', id: String(created._id), ...plan }, null, 2));
  await disconnectMongo();
}

main().catch((e) => { /* eslint-disable-next-line no-console */ console.error('ERROR:', (e as Error).message); process.exit(1); });
