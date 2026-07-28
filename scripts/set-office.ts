/* eslint-disable no-console */
// Set a branch's office geofence (the thing attendance punches are validated against).
// DRY-RUN by default — prints exactly what it would write. Pass --apply to actually write.
// Idempotent: an existing office at the same branch+label is UPDATED, never duplicated.
//
//   npx ts-node scripts/set-office.ts --branch AMD --lat 23.0317354 --lng 72.5707126 \
//     --wifi "Airtel_Travkings" [--radius 100] [--label "AMD Office"] [--apply]
//
// Equivalent to Admin → Office locations in the app; this exists for exact coordinates, which
// are easier to paste than to type on a phone.
import 'dotenv/config';
import { connectMongo, disconnectMongo } from '../src/mongo/connection';
import { crmRepo } from '../src/mongo/crm.repo';
import { officeRepo } from '../src/mongo/attendance/office.repository';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const APPLY = process.argv.includes('--apply');

async function main(): Promise<void> {
  const code = (arg('branch') ?? '').toUpperCase();
  const lat = Number(arg('lat'));
  const lng = Number(arg('lng'));
  const wifi = arg('wifi') ?? null;
  const radius = Number(arg('radius') ?? 100);
  if (!code || !Number.isFinite(lat) || !Number.isFinite(lng)) {
    throw new Error('usage: --branch AMD --lat <n> --lng <n> [--wifi SSID] [--radius 100] [--label ..] [--apply]');
  }
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) throw new Error('lat/lng out of range');
  if (radius < 20 || radius > 5000) throw new Error('radius must be 20..5000 m'); // same clamp as the API

  await connectMongo();
  const branches = await crmRepo.listBranches();
  const branch = branches.find((b) => (b.code ?? '').toUpperCase() === code);
  if (!branch) {
    throw new Error(`No branch with code ${code}. Known: ${branches.map((b) => b.code).filter(Boolean).join(', ')}`);
  }
  const branchId = String(branch._id);
  const label = arg('label') ?? `${code} Office`;

  const existing = await officeRepo.allByBranchIds([branchId]);
  const match = existing.find((o) => (o.label ?? '') === label) ?? (existing.length === 1 ? existing[0] : undefined);

  console.log(`branch      : ${branch.code} — ${branch.name ?? branch.city ?? ''} (${branchId})`);
  console.log(`offices now : ${existing.length ? existing.map((o) => `${o.label ?? '—'} @${o.lat},${o.lng} r${o.radius}${o.isDefault ? ' ★default' : ''}${o.active ? '' : ' [inactive]'}`).join(' | ') : '(none)'}`);
  console.log(`action      : ${match ? `UPDATE "${match.label ?? '—'}" (${String(match._id)})` : 'CREATE'}`);
  console.log(`  label     : ${label}`);
  console.log(`  lat,lng   : ${lat}, ${lng}`);
  console.log(`  radius    : ${radius} m`);
  console.log(`  wifiSsid  : ${wifi ?? '(none)'}`);

  if (!APPLY) {
    console.log('\nDRY RUN — nothing written. Re-run with --apply to save.');
    await disconnectMongo();
    return;
  }

  const set = { lat, lng, radius, wifiSsid: wifi, label, active: true, updatedBy: 'script:set-office' };
  const officeId = match
    ? String((await officeRepo.updateById(String(match._id), set))!._id)
    : String((await officeRepo.create({ ...set, branchId, tenantId: branch.tenant_id ? String(branch.tenant_id) : null, isDefault: false }))._id);
  // Staff with no explicit office assignment fall back to their branch's DEFAULT — so the first
  // office in a branch must become the default or nobody can punch there.
  if (!existing.some((o) => o.isDefault)) await officeRepo.setDefault(branchId, officeId);

  const after = await officeRepo.allByBranchIds([branchId]);
  console.log('\nSaved. Offices now:');
  for (const o of after) console.log(`  ${o.label ?? '—'} @${o.lat},${o.lng} r${o.radius} wifi=${o.wifiSsid ?? '—'}${o.isDefault ? ' ★default' : ''}`);
  await disconnectMongo();
}

main().catch((e) => { console.error((e as Error).message); process.exit(1); });
