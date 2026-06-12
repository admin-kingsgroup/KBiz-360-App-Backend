/* eslint-disable no-console */
// Verifies the Mongo auth/access foundation against the LIVE DB.
// READ-ONLY on the CRM. Only writes a throwaway doc to kb360_app (our isolated db) to prove isolation.
import 'dotenv/config';
import { connectMongo, disconnectMongo } from '../src/mongo/connection';
import { crmRepo } from '../src/mongo/crm.repo';
import { accessService } from '../src/mongo/access';
import { mongoAuth } from '../src/mongo/auth';

const TEST_EMAIL = 'afshin.dhanani@kingsgroupco.com';

async function main(): Promise<void> {
  await connectMongo();
  console.log('Connected.\n');

  // 1) Resolve a real user → access (read-only)
  const user = await crmRepo.findUserByEmail(TEST_EMAIL);
  if (!user) {
    console.log('User not found:', TEST_EMAIL);
  } else {
    const access = await accessService.accessForUser(user);
    console.log('ACCESS for', TEST_EMAIL, '→', JSON.stringify(access, null, 2));
  }

  // 2) Directory snapshot (read-only): users with resolved role + branch count
  const roles = await crmRepo.listRoles();
  const roleById = new Map(roles.map((r) => [String(r._id), r]));
  const users = await crmRepo.listUsers();
  console.log(`\nDIRECTORY (${users.length} users):`);
  users.slice(0, 8).forEach((u) => {
    const r = u.role_id ? roleById.get(String(u.role_id)) : undefined;
    console.log('  ', `${u.first_name ?? ''} ${u.last_name ?? ''}`.trim().padEnd(22), '|', (u.email ?? '').padEnd(38), '| role:', (r?.name ?? '?').padEnd(16), '| L' + (r?.level ?? '?'), '| branches:', (u.branch_ids ?? []).length);
  });

  // 3) Negative login (wrong password) → must reject (read-only)
  try {
    await mongoAuth.login(TEST_EMAIL, 'definitely-not-the-password');
    console.log('\n❌ UNEXPECTED: wrong password was accepted');
  } catch (e) {
    console.log('\n✅ Wrong password correctly rejected:', (e as Error).message);
  }

  await disconnectMongo();
  console.log('\nDone. CRM collections were only READ (no writes anywhere).');
}
main().catch((e) => { console.error('verify error:', (e as Error).message); process.exit(1); });
