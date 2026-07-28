/* eslint-disable no-console */
// Set EVERY office geofence radius to a single value (default 100 m) — the "auto check-in when
// within 100 m of the branch" rollout. DRY-RUN by default: prints each office and what would
// change. Pass --apply to actually write. Offices already at the target are left untouched.
//
//   npx ts-node scripts/set-office-radius.ts [--radius 100] [--apply]
//
// Note: the OS arms regions at max(radius, 100) — region monitoring is unreliable below ~100 m —
// so values under 100 tighten only the server-side punch validation, not the geofence trigger.
import 'dotenv/config';
import { connectMongo, disconnectMongo } from '../src/mongo/connection';
import { OfficeGeofenceModel } from '../src/mongo/attendance/office.model';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const APPLY = process.argv.includes('--apply');

async function main(): Promise<void> {
  const radius = Number(arg('radius') ?? 100);
  if (radius < 20 || radius > 5000) throw new Error('radius must be 20..5000 m'); // same clamp as the API

  await connectMongo();
  const offices = await OfficeGeofenceModel().find({}).lean();
  const changing = offices.filter((o) => o.radius !== radius);

  console.log(`target radius : ${radius} m`);
  console.log(`offices       : ${offices.length} total, ${changing.length} to change`);
  for (const o of offices) {
    const mark = o.radius === radius ? '  (already)' : `  r${o.radius} → r${radius}`;
    console.log(`  ${o.label ?? '—'} @${o.lat},${o.lng}${o.active ? '' : ' [inactive]'}${mark}`);
  }

  if (!APPLY) {
    console.log('\nDRY RUN — nothing written. Re-run with --apply to save.');
    await disconnectMongo();
    return;
  }

  const res = await OfficeGeofenceModel().updateMany(
    { radius: { $ne: radius } },
    { $set: { radius, updatedBy: 'script:set-office-radius' } },
  );
  console.log(`\nSaved — ${res.modifiedCount} office(s) updated to ${radius} m.`);
  await disconnectMongo();
}

main().catch((e) => { console.error((e as Error).message); process.exit(1); });
