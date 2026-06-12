/* eslint-disable no-console */
// End-to-end test of the audio-calling backend against a RUNNING server (npm run start:mongo).
// Signs JWTs for two real CRM users (server's secret), connects two Socket.IO clients, and drives
// full call flows through REST + socket signaling + Mongo, asserting every state transition.
// Run: npx ts-node scripts/calls-e2e.ts
import 'dotenv/config';
import { io, type Socket } from 'socket.io-client';
import { connectMongo, disconnectMongo } from '../src/mongo/connection';
import { crmRepo } from '../src/mongo/crm.repo';
import { signAccess } from '../src/modules/auth/jwt';
import { ActiveCallModel, CallLogModel } from '../src/mongo/calls/call.models';

const BASE = process.env.E2E_BASE ?? 'http://localhost:4000';

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, extra = ''): void => {
  if (ok) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}${extra ? ` — ${extra}` : ''}`); }
};

interface ApiRes { status: number; json: any }
async function api(path: string, token: string | null, method = 'GET', body?: unknown): Promise<ApiRes> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

function waitFor<T = any>(sock: Socket, event: string, ms = 6000): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), ms);
    sock.once(event, (p: T) => { clearTimeout(t); resolve(p); });
  });
}
const connect = (token: string): Promise<Socket> =>
  new Promise((resolve, reject) => {
    const s = io(BASE, { auth: { token }, transports: ['websocket'], reconnection: false });
    s.on('connect', () => resolve(s));
    s.on('connect_error', reject);
    setTimeout(() => reject(new Error('socket connect timeout')), 6000);
  });

async function main(): Promise<void> {
  await connectMongo();
  const users = await crmRepo.listUsers({ status: 'active' });
  const pickable = users.filter((u) => u._id).slice(0, 2);
  if (pickable.length < 2) { console.error('Need at least 2 active CRM users to test'); process.exit(1); }
  const [A, B] = pickable;
  const aId = String(A._id), bId = String(B._id);
  console.log(`\nE2E calling test against ${BASE}\n  caller A = ${A.email} (${aId})\n  callee B = ${B.email} (${bId})\n`);

  // Clean any stale active calls for these two so duplicate-guard doesn't false-fail.
  await ActiveCallModel().deleteMany({ $or: [{ callerId: { $in: [aId, bId] } }, { receiverId: { $in: [aId, bId] } }] });

  const tokenA = signAccess(aId, 'employee');
  const tokenB = signAccess(bId, 'employee');
  const sockA = await connect(tokenA);
  const sockB = await connect(tokenB);
  console.log('Sockets connected.\n');

  // ── ice-servers ──
  console.log('ICE servers:');
  const ice = await api('/api/calls/ice-servers', tokenA);
  check('GET /ice-servers returns a STUN server', ice.status === 200 && Array.isArray(ice.json?.iceServers) && ice.json.iceServers.length >= 1, JSON.stringify(ice.json));

  // ── security ──
  console.log('\nSecurity:');
  const noAuth = await api('/api/calls/history', null);
  check('history without token → 401', noAuth.status === 401);
  const selfCall = await api('/api/calls/initiate', tokenA, 'POST', { receiverId: aId });
  check('self-call → 400', selfCall.status === 400, `got ${selfCall.status}`);

  // ── completed call flow ──
  console.log('\nCompleted call flow:');
  const incomingP = waitFor(sockB, 'call:incoming');
  const init = await api('/api/calls/initiate', tokenA, 'POST', { receiverId: bId, type: 'voice' });
  check('A initiate → 201 with callId + iceServers', init.status === 201 && !!init.json?.call?.callId && Array.isArray(init.json?.iceServers), `status ${init.status}`);
  const callId = init.json?.call?.callId as string;
  const incoming: any = await incomingP.catch((e) => ({ error: e.message }));
  check('B receives call:incoming with same callId + caller', incoming?.callId === callId && !!incoming?.caller?.id, JSON.stringify(incoming));

  // duplicate guard: A initiating again while busy → 409
  const dup = await api('/api/calls/initiate', tokenA, 'POST', { receiverId: bId });
  check('duplicate call while busy → 409', dup.status === 409, `got ${dup.status}`);

  const acceptedP = waitFor(sockA, 'call:accept');
  const acc = await api('/api/calls/accept', tokenB, 'POST', { callId });
  check('B accept → 200', acc.status === 200);
  const accepted: any = await acceptedP.catch((e) => ({ error: e.message }));
  check('A receives call:accept', accepted?.callId === callId, JSON.stringify(accepted));

  // signaling relay: A → B offer
  const offerP = waitFor(sockB, 'call:offer');
  sockA.emit('call:offer', { callId, to: bId, sdp: { type: 'offer', sdp: 'v=0...' } });
  const offer: any = await offerP.catch((e) => ({ error: e.message }));
  check('offer relayed A→B (participant-verified)', offer?.callId === callId && offer?.from === aId, JSON.stringify(offer));

  // bogus relay to a non-participant must NOT be delivered
  let leaked = false;
  sockA.once('call:ice-candidate', () => { leaked = true; });
  sockB.emit('call:ice-candidate', { callId, to: 'deadbeefdeadbeefdeadbeef', candidate: { x: 1 } });
  await new Promise((r) => setTimeout(r, 400));
  check('relay to non-participant is dropped', !leaked);

  const endedP = waitFor(sockB, 'call:end');
  const end = await api('/api/calls/end', tokenA, 'POST', { callId });
  check('A end → completed', end.status === 200 && end.json?.status === 'completed', JSON.stringify(end.json));
  const ended: any = await endedP.catch((e) => ({ error: e.message }));
  check('B receives call:end', ended?.callId === callId, JSON.stringify(ended));

  // persistence
  const log = await CallLogModel().findOne({ callId }).lean();
  check('call_logs has a completed row', log?.status === 'completed');
  const stillActive = await ActiveCallModel().findOne({ callId }).lean();
  check('active_calls cleared after end', stillActive === null);

  const hist = await api('/api/calls/history', tokenA);
  check('history (A) includes the call', hist.status === 200 && Array.isArray(hist.json?.calls) && hist.json.calls.some((c: any) => c.callId === callId));

  // ── rejected call flow ──
  console.log('\nRejected call flow:');
  const incoming2P = waitFor(sockB, 'call:incoming');
  const init2 = await api('/api/calls/initiate', tokenA, 'POST', { receiverId: bId });
  const callId2 = init2.json?.call?.callId as string;
  await incoming2P.catch(() => undefined);
  const rejectedP = waitFor(sockA, 'call:reject');
  const rej = await api('/api/calls/reject', tokenB, 'POST', { callId: callId2 });
  check('B reject → 200', rej.status === 200);
  const rejected: any = await rejectedP.catch((e) => ({ error: e.message }));
  check('A receives call:reject', rejected?.callId === callId2, JSON.stringify(rejected));
  const log2 = await CallLogModel().findOne({ callId: callId2 }).lean();
  check('call_logs has a rejected row', log2?.status === 'rejected');

  sockA.close();
  sockB.close();
  await disconnectMongo();

  console.log(`\n──────── RESULT: ${pass} passed, ${fail} failed ────────\n`);
  process.exit(fail ? 1 : 0);
}

void main().catch((err) => { console.error('E2E error:', err); process.exit(1); });
