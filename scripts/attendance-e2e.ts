/* eslint-disable no-console */
// E2E for the attendance backend against a RUNNING server. Signs a JWT for a real user and drives
// check-in → me → check-out → team + guards, then cleans up today's row.
// Run: E2E_BASE=http://localhost:4001 npx ts-node scripts/attendance-e2e.ts
import 'dotenv/config';
import { connectMongo, disconnectMongo } from '../src/mongo/connection';
import { crmRepo } from '../src/mongo/crm.repo';
import { signAccess } from '../src/modules/auth/jwt';
import { AttendanceModel } from '../src/mongo/attendance/attendance.model';

const BASE = process.env.E2E_BASE ?? 'http://localhost:4001';
let pass = 0, fail = 0;
const check = (label: string, ok: boolean, extra = ''): void => {
  if (ok) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.log(`  ✗ ${label}${extra ? ` — ${extra}` : ''}`); }
};
interface ApiRes { status: number; json: any }
async function api(path: string, token: string | null, method = 'GET', body?: unknown): Promise<ApiRes> {
  const res = await fetch(`${BASE}${path}`, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

async function main(): Promise<void> {
  await connectMongo();
  const A = (await crmRepo.listUsers({ status: 'active' }))[0];
  const aId = String(A._id);
  const token = signAccess(aId, 'employee');
  const dateKey = new Date().toISOString().slice(0, 10);
  console.log(`\nAttendance E2E against ${BASE}\n  user = ${A.email}\n`);

  // start clean for today
  await AttendanceModel().deleteOne({ userId: aId, dateKey });

  try {
    const me0 = await api('/api/attendance/me', token);
    check('GET /me before punch → not checked in', me0.status === 200 && me0.json?.inTime === null, JSON.stringify(me0.json));

    const ci = await api('/api/attendance/check-in', token, 'POST', { wifiOn: true, coords: { lat: 19.07, lng: 72.87 }, method: 'auto' });
    check('check-in → inTime set, present, via Wi-Fi', ci.status === 200 && !!ci.json?.inTime && ci.json?.present === true && ci.json?.via === 'Wi-Fi', JSON.stringify(ci.json));

    const ci2 = await api('/api/attendance/check-in', token, 'POST', { wifiOn: true });
    check('double check-in → 400', ci2.status === 400, `got ${ci2.status}`);

    const me1 = await api('/api/attendance/me', token);
    check('GET /me after check-in → inTime present', !!me1.json?.inTime);

    const co = await api('/api/attendance/check-out', token, 'POST', { method: 'face' });
    check('check-out → outTime set, faceVerified', co.status === 200 && !!co.json?.outTime && co.json?.faceVerified === true, JSON.stringify(co.json));

    const co2 = await api('/api/attendance/check-out', token, 'POST', {});
    check('double check-out → 400', co2.status === 400, `got ${co2.status}`);

    const team = await api('/api/attendance/team', token);
    const mine = Array.isArray(team.json) ? team.json.find((t: any) => t.id === aId) : null;
    check('GET /team → array including me with in/out times', Array.isArray(team.json) && !!mine?.in && !!mine?.out, JSON.stringify(mine));

    const noTok = await api('/api/attendance/me', null);
    check('GET /me without token → 401', noTok.status === 401);
  } finally {
    await AttendanceModel().deleteOne({ userId: aId, dateKey });
    await disconnectMongo();
  }

  console.log(`\n──────── RESULT: ${pass} passed, ${fail} failed ────────\n`);
  process.exit(fail ? 1 : 0);
}
void main().catch((e) => { console.error('E2E error:', e); process.exit(1); });
