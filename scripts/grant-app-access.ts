/* eslint-disable no-console */
// Grant Smart Connect login access (access.app = true) to existing users by email.
// The login gate (src/mongo/auth.ts) is DENY-by-default on access.app === true, so users
// created before that flag was set are locked out with "ask an administrator to enable it".
// New users created from the app now get access.app = true automatically (directory.service.ts);
// this script backfills the ones created earlier.
//
// DRY-RUN by default — prints what it would change. Pass --apply to write.
// Idempotent: a user already granted is reported and skipped.
//
//   npx ts-node scripts/grant-app-access.ts test@gmail.com test@vish1gmail.com [--apply]
import 'dotenv/config';
import { connectMongo, disconnectMongo } from '../src/mongo/connection';
import { crmRepo } from '../src/mongo/crm.repo';

const APPLY = process.argv.includes('--apply');

async function main(): Promise<void> {
  const emails = process.argv.slice(2).filter((a) => !a.startsWith('--')).map((e) => e.trim().toLowerCase());
  if (!emails.length) throw new Error('usage: grant-app-access.ts <email> [<email> ...] [--apply]');

  await connectMongo();
  for (const email of emails) {
    const user = await crmRepo.findUserByEmail(email);
    if (!user) { console.log(`SKIP  ${email} — no such user`); continue; }
    if (user.access?.app === true) { console.log(`OK    ${email} — already has app access`); continue; }
    console.log(`GRANT ${email} — access.app ${String(user.access?.app)} -> true`);
    // Merge, don't clobber: preserve any crm/erp toggles already on the user.
    if (APPLY) await crmRepo.updateUser(String(user._id), { access: { ...(user.access ?? {}), app: true } });
  }

  if (!APPLY) console.log('\nDRY RUN — nothing written. Re-run with --apply to save.');
  await disconnectMongo();
}

main().catch((e) => { console.error((e as Error).message); process.exit(1); });
