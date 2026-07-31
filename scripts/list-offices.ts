/* eslint-disable no-console */
// READ-ONLY: list every CRM branch and its configured office geofences.
import 'dotenv/config';
import { connectMongo, disconnectMongo } from '../src/mongo/connection';
import { crmRepo } from '../src/mongo/crm.repo';
import { officeRepo } from '../src/mongo/attendance/office.repository';

async function main(): Promise<void> {
  await connectMongo();
  const branches = await crmRepo.listBranches();
  for (const b of branches) {
    const offices = await officeRepo.allByBranchIds([String(b._id)]);
    const line = offices.length
      ? offices.map((o) => `${o.label ?? '—'} @${o.lat},${o.lng} r${o.radius}m wifi=${o.wifiSsid ?? '—'}${o.isDefault ? ' ★default' : ''}${o.active ? '' : ' [INACTIVE]'}`).join(' | ')
      : '(NO OFFICE — punches allowed unverified)';
    console.log(`${(b.code ?? '??').padEnd(6)} ${line}`);
  }
  await disconnectMongo();
}

main().catch((e) => { console.error((e as Error).message); process.exit(1); });
