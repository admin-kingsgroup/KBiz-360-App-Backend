/* eslint-disable no-console */
// READ-ONLY: explains the Team count (tenant-scoped). No writes.
import 'dotenv/config';
import { connectMongo, disconnectMongo } from '../src/mongo/connection';
import { crmRepo } from '../src/mongo/crm.repo';

async function main(): Promise<void> {
  await connectMongo();
  const all = await crmRepo.listUsers();
  const afshin = await crmRepo.findUserByEmail('afshin.dhanani@kingsgroupco.com');
  const tenant = afshin?.tenant_id ? String(afshin.tenant_id) : null;
  const inTenant = all.filter((u) => (u.tenant_id ? String(u.tenant_id) : null) === tenant);
  const outside = all.filter((u) => (u.tenant_id ? String(u.tenant_id) : null) !== tenant);
  console.log('total users:', all.length);
  console.log('Afshin tenant:', tenant);
  console.log('in-tenant (shown in Team):', inTenant.length);
  console.log('excluded (other/!no tenant):', outside.map((u) => ({ name: `${u.first_name ?? ''} ${u.last_name ?? ''}`.trim(), email: u.email, tenant: u.tenant_id ? String(u.tenant_id) : null, status: u.status })));
  await disconnectMongo();
}
main().catch((e) => { console.error((e as Error).message); process.exit(1); });
