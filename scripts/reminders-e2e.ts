/* eslint-disable no-console */
// End-to-end test of the reminders backend against a RUNNING server. Signs JWTs for two real CRM
// users and exercises create → list (tabs) → complete → review → approve → archive + security,
// asserting state transitions and Mongo persistence. Cleans up the reminders it creates.
// Run: E2E_BASE=http://localhost:4001 npx ts-node scripts/reminders-e2e.ts
import 'dotenv/config';
import { connectMongo, disconnectMongo } from '../src/mongo/connection';
import { crmRepo } from '../src/mongo/crm.repo';
import { signAccess } from '../src/modules/auth/jwt';
import { ReminderModel } from '../src/mongo/reminders/reminder.model';
import { PushDeviceModel } from '../src/mongo/calls/call.models';
import { Types } from 'mongoose';

const TEST_TOKEN = 'ExponentPushToken[e2e-reminder-test]';

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
const hasId = (r: ApiRes, id: string): boolean => Array.isArray(r.json?.visible) && r.json.visible.some((x: any) => x.id === id);

async function main(): Promise<void> {
  await connectMongo();
  const users = (await crmRepo.listUsers({ status: 'active' })).filter((u) => u._id).slice(0, 3);
  if (users.length < 3) { console.error('Need 3 active users'); process.exit(1); }
  const [A, B, C] = users;
  const aId = String(A._id), bId = String(B._id), cId = String(C._id);
  const tokenA = signAccess(aId, 'employee'), tokenB = signAccess(bId, 'employee'), tokenC = signAccess(cId, 'employee');
  console.log(`\nReminders E2E against ${BASE}\n  A (creator) = ${A.email}\n  B (assignee) = ${B.email}\n`);

  const created: string[] = [];
  try {
    // Register a push token for B so create() exercises the "assigned" push (dry-run logs to stdout).
    await api('/api/calls/register-device', tokenB, 'POST', { expoPushToken: TEST_TOKEN, platform: 'android' });

    // A assigns a reminder to B
    console.log('Assigned reminder (A → B):');
    const c1 = await api('/api/reminders', tokenA, 'POST', { text: 'E2E: reconcile BSP refunds', forId: bId, when: 'Today · 3:00 PM' });
    check('A create → 201, pending, forId=B, byId=A', c1.status === 201 && c1.json?.state === 'pending' && c1.json?.forId === bId && c1.json?.byId === aId, JSON.stringify(c1.json));
    const id1 = c1.json?.id as string; created.push(id1);

    const iset = await api('/api/reminders?tab=iset', tokenA);
    check('A "I set" includes it', hasId(iset, id1));
    const forme = await api('/api/reminders?tab=forme', tokenB);
    check('B "For me" includes it', hasId(forme, id1));
    check('groups carry assignee name + sub', forme.json?.groups?.length >= 1 && !!forme.json.groups[0].name);

    // B completes → review (assigned by someone else)
    const done = await api(`/api/reminders/${id1}`, tokenB, 'PATCH', { action: 'complete' });
    check('B complete → result "review"', done.status === 200 && done.json?.result === 'review' && done.json?.reminder?.state === 'review', JSON.stringify(done.json));
    const review = await api('/api/reminders?tab=review', tokenA);
    check('A "Review" includes it + reviewCount ≥ 1', hasId(review, id1) && review.json?.reviewCount >= 1);

    // security: B (not creator) cannot approve
    const badApprove = await api(`/api/reminders/${id1}`, tokenB, 'PATCH', { action: 'approve' });
    check('B approve (not creator) → 403', badApprove.status === 403, `got ${badApprove.status}`);

    // A approves → archived
    const appr = await api(`/api/reminders/${id1}`, tokenA, 'PATCH', { action: 'approve' });
    check('A approve → result "approved"', appr.status === 200 && appr.json?.result === 'approved');
    const archive = await api('/api/reminders?tab=archive', tokenA);
    check('A "Archive" includes it', hasId(archive, id1));

    // self reminder → complete archives immediately
    console.log('\nSelf reminder (A → A):');
    const c2 = await api('/api/reminders', tokenA, 'POST', { text: 'E2E: self note', forId: aId });
    const id2 = c2.json?.id as string; created.push(id2);
    const selfDone = await api(`/api/reminders/${id2}`, tokenA, 'PATCH', { action: 'complete' });
    check('self complete → result "archived" + approved', selfDone.json?.result === 'archived' && selfDone.json?.reminder?.state === 'approved', JSON.stringify(selfDone.json));

    // security: unknown assignee, no-token
    console.log('\nSecurity:');
    const noTok = await api('/api/reminders', null);
    check('list without token → 401', noTok.status === 401);
    const badForId = await api('/api/reminders', tokenA, 'POST', { text: 'x', forId: 'deadbeefdeadbeefdeadbeef' });
    check('unknown assignee → 400', badForId.status === 400, `got ${badForId.status}`);

    // delete: non-owner non-manager B cannot delete A's self note; A can
    const badDel = await api(`/api/reminders/${id2}`, tokenB, 'DELETE');
    check('B delete A\'s reminder → 403', badDel.status === 403, `got ${badDel.status}`);
    const del = await api(`/api/reminders/${id2}`, tokenA, 'DELETE');
    check('A delete → 204', del.status === 204);

    // ── reassign flow (B → C) ──
    console.log('\nReassign flow (A reassigns B → C):');
    const c3 = await api('/api/reminders', tokenA, 'POST', { text: 'E2E: reassign me', forId: bId });
    const id3 = c3.json?.id as string; created.push(id3);
    await api(`/api/reminders/${id3}`, tokenB, 'PATCH', { action: 'complete' }); // B completes → review
    const rea = await api(`/api/reminders/${id3}`, tokenA, 'PATCH', { forId: cId });
    check('A reassign → 200, forId=C, back to pending', rea.status === 200 && rea.json?.reminder?.forId === cId && rea.json?.reminder?.state === 'pending', JSON.stringify(rea.json));
    const cForme = await api('/api/reminders?tab=forme', tokenC);
    check('C "For me" includes the reassigned reminder', hasId(cForme, id3));
    const badRea = await api(`/api/reminders/${id3}`, tokenB, 'PATCH', { forId: aId });
    check('B reassign (not creator) → 403', badRea.status === 403, `got ${badRea.status}`);
  } finally {
    // cleanup any remaining test reminders
    const ids = created.filter((x) => Types.ObjectId.isValid(x)).map((x) => new Types.ObjectId(x));
    if (ids.length) await ReminderModel().deleteMany({ _id: { $in: ids } });
    await PushDeviceModel().deleteOne({ expoPushToken: TEST_TOKEN });
    await disconnectMongo();
  }

  console.log(`\n──────── RESULT: ${pass} passed, ${fail} failed ────────\n`);
  process.exit(fail ? 1 : 0);
}
void main().catch((e) => { console.error('E2E error:', e); process.exit(1); });
