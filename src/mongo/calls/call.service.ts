import crypto from 'crypto';
import { Types } from 'mongoose';
import { config } from '../../config';
import { AppError, BadRequest, Forbidden, NotFound } from '../../common/errors';
import { crmRepo, type CrmUser } from '../crm.repo';
import { emitToUser, isOnline, setInCall, broadcastPresence } from '../chat/chat.events';
import { activeCallRepo, callLogRepo, callAnalyticsRepo, type AnalyticsFilter, type HistoryPage } from './call.repository';
import { callPush } from './call.push';
import { callFcm } from './call.fcm';
import { callVoip } from './call.voip';
import {
  CALL_EVENTS,
  toCallDTO,
  toCallLogDTO,
  type CallDTO,
  type CallLogDTO,
  type IceServer,
} from './call.types';
import type { CallLogStatus, CallMediaType } from './call.models';

const Conflict = (msg: string): AppError => new AppError(409, msg, 'CONFLICT');

const nameOf = (u: CrmUser): string =>
  `${u.first_name ?? ''} ${u.last_name ?? ''}`.trim() || u.email || 'Unknown';

// Resolve display names for a set of user ids in one CRM read.
async function resolveNames(ids: string[]): Promise<Map<string, string>> {
  const oids = [...new Set(ids)].filter((id) => Types.ObjectId.isValid(id)).map((id) => new Types.ObjectId(id));
  const map = new Map<string, string>();
  if (!oids.length) return map;
  const users = await crmRepo.listUsers({ _id: { $in: oids } });
  for (const u of users) map.set(String(u._id), nameOf(u));
  return map;
}

// In-memory ring timers (single instance). active_calls.expiresAt TTL is the cross-instance safety net.
const ringTimers = new Map<string, NodeJS.Timeout>();
const clearRing = (callId: string): void => {
  const t = ringTimers.get(callId);
  if (t) { clearTimeout(t); ringTimers.delete(callId); }
};

// Time-limited TURN credentials (coturn `use-auth-secret` / RFC 5766 TURN REST API): the username is
// an expiry timestamp and the password is HMAC-SHA1(username, secret). The app gets fresh, short-lived
// creds per call — nothing long-lived is shipped in the client. Falls back to static creds if no
// secret is configured, and to STUN-only if no TURN at all.
function turnCredentials(): { username: string; credential: string } | null {
  const { turnSecret, turnTtlSec, turnUsername, turnPassword } = config.calls;
  if (turnSecret) {
    const username = `${Math.floor(Date.now() / 1000) + turnTtlSec}:kb360`;
    const credential = crypto.createHmac('sha1', turnSecret).update(username).digest('base64');
    return { username, credential };
  }
  if (turnUsername && turnPassword) return { username: turnUsername, credential: turnPassword };
  return null;
}

function iceServers(): IceServer[] {
  const servers: IceServer[] = [{ urls: config.calls.stunUrl }];
  const creds = turnCredentials();
  if (config.calls.turnUrls.length && creds) {
    servers.push({ urls: config.calls.turnUrls, username: creds.username, credential: creds.credential });
  }
  return servers;
}

export const callService = {
  iceServers,

  // POST /calls/initiate — caller starts ringing the receiver.
  async initiate(callerId: string, receiverId: string, type: CallMediaType): Promise<{ call: CallDTO; iceServers: IceServer[] }> {
    if (receiverId === callerId) throw BadRequest('You cannot call yourself');

    const [caller, receiver] = await Promise.all([crmRepo.getUserById(callerId), crmRepo.getUserById(receiverId)]);
    if (!receiver) throw NotFound('Receiver not found');
    if (!caller) throw NotFound('Caller not found');

    // eslint-disable-next-line no-console
    console.log(`[call] initiate caller=${callerId} receiver=${receiverId} type=${type}`);
    // Block overlapping calls on either side.
    const [callerBusy, receiverBusy] = await Promise.all([
      activeCallRepo.activeForUser(callerId),
      activeCallRepo.activeForUser(receiverId),
    ]);
    // eslint-disable-next-line no-console
    if (callerBusy || receiverBusy) console.log(`[call] BUSY callerBusy=${!!callerBusy} receiverBusy=${!!receiverBusy} (stale active_calls?)`);
    if (callerBusy) throw Conflict('You are already in a call');
    if (receiverBusy) throw Conflict('User is busy on another call');

    const callId = crypto.randomUUID();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + (config.calls.ringTimeoutSec + 15) * 1000);
    const doc = await activeCallRepo.create({
      callId, callerId, receiverId, type, status: 'ringing', startedAt: now, acceptedAt: null, expiresAt,
    });

    const callerName = nameOf(caller);
    const dto = toCallDTO(doc, callerName, nameOf(receiver));

    // Realtime ring to the receiver's connected devices.
    emitToUser(receiverId, CALL_EVENTS.INCOMING, { callId, type, caller: dto.caller, startedAt: dto.startedAt });
    // Native incoming-call UI when backgrounded/killed:
    //   • iOS  → Apple VoIP/PushKit → CallKit screen — ONLY for devices that registered a VoIP token.
    //   • Android → DATA FCM message → notifee full-screen UI (client's background handler).
    // We skip iOS from the FCM call path only when the receiver actually has a VoIP token (a new build
    // with CallKit). Older iOS builds (no VoIP token) still get the FCM alert — avoids both a double
    // notification on new builds and a silent miss on old ones. No TURN → Expo push fallback otherwise.
    const hasVoip = callVoip.configured() && (await callVoip.deviceCount(receiverId)) > 0;
    // eslint-disable-next-line no-console
    console.log(`[call] ringing callId=${callId} receiverOnline=${isOnline(receiverId)} fcm=${callFcm.configured()} voip=${hasVoip}`);
    if (hasVoip) void callVoip.sendIncomingCall(receiverId, callerName, { callId, type, callerId });
    if (callFcm.configured()) {
      void callFcm.sendIncomingCall(receiverId, callerName, { callId, type, callerId }, { skipIos: hasVoip });
    } else if (!hasVoip && !isOnline(receiverId)) {
      await callPush.sendIncomingCall(receiverId, callerName, { callId, type });
    }

    // Auto-miss if unanswered.
    ringTimers.set(callId, setTimeout(() => void callService.markMissed(callId), config.calls.ringTimeoutSec * 1000));

    return { call: dto, iceServers: iceServers() };
  },

  // POST /calls/accept — receiver answers.
  async accept(userId: string, callId: string): Promise<{ ok: true }> {
    const active = await activeCallRepo.byCallId(callId);
    if (!active) throw NotFound('Call not found or already ended');
    if (active.receiverId !== userId) throw Forbidden('Only the receiver can accept this call');
    if (active.status !== 'ringing') throw Conflict('Call is not ringing');

    clearRing(callId);
    await activeCallRepo.update(callId, { status: 'accepted', acceptedAt: new Date() });

    emitToUser(active.callerId, CALL_EVENTS.ACCEPTED, { callId });
    setInCall(active.callerId, true); broadcastPresence(active.callerId);
    setInCall(active.receiverId, true); broadcastPresence(active.receiverId);
    return { ok: true };
  },

  // POST /calls/reject — receiver declines a ringing call.
  async reject(userId: string, callId: string): Promise<{ ok: true }> {
    const active = await activeCallRepo.byCallId(callId);
    if (!active) throw NotFound('Call not found or already ended');
    if (active.receiverId !== userId) throw Forbidden('Only the receiver can reject this call');

    clearRing(callId);
    await this.finalize(active.callId, 'rejected', 0, userId, active);
    emitToUser(active.callerId, CALL_EVENTS.REJECTED, { callId });
    return { ok: true };
  },

  // POST /calls/end — either party hangs up (also covers cancel-before-answer).
  async end(userId: string, callId: string): Promise<{ ok: true; status: CallLogStatus; durationSec: number }> {
    const active = await activeCallRepo.byCallId(callId);
    if (!active) return { ok: true, status: 'completed', durationSec: 0 }; // idempotent
    if (active.callerId !== userId && active.receiverId !== userId) throw Forbidden('Not a participant of this call');

    clearRing(callId);
    const now = new Date();
    const wasAccepted = active.status === 'accepted' && !!active.acceptedAt;
    const status: CallLogStatus = wasAccepted ? 'completed' : 'missed';
    const durationSec = wasAccepted ? Math.max(0, Math.round((now.getTime() - active.acceptedAt!.getTime()) / 1000)) : 0;

    await this.finalize(callId, status, durationSec, userId, active, now);

    const other = userId === active.callerId ? active.receiverId : active.callerId;
    emitToUser(other, CALL_EVENTS.ENDED, { callId, endedBy: userId, status, durationSec });
    setInCall(active.callerId, false); broadcastPresence(active.callerId);
    setInCall(active.receiverId, false); broadcastPresence(active.receiverId);
    return { ok: true, status, durationSec };
  },

  // Ring timeout fired with the call still ringing → missed for both sides.
  async markMissed(callId: string): Promise<void> {
    clearRing(callId);
    const active = await activeCallRepo.byCallId(callId);
    if (!active || active.status !== 'ringing') return;
    await this.finalize(callId, 'missed', 0, null, active);
    emitToUser(active.callerId, CALL_EVENTS.MISSED, { callId });
    emitToUser(active.receiverId, CALL_EVENTS.MISSED, { callId });
  },

  // Write the terminal call_log row and drop the active_call. Internal.
  async finalize(
    callId: string,
    status: CallLogStatus,
    durationSec: number,
    endedBy: string | null,
    active: { callerId: string; receiverId: string; type: CallMediaType; startedAt: Date; acceptedAt: Date | null },
    endedAt: Date = new Date(),
  ): Promise<void> {
    await callLogRepo.insert({
      callId,
      callerId: active.callerId,
      receiverId: active.receiverId,
      type: active.type,
      status,
      startedAt: active.startedAt,
      acceptedAt: active.acceptedAt,
      endedAt,
      durationSec,
      endedBy,
    });
    await activeCallRepo.remove(callId);
    // Dismiss any lingering incoming-call UI on the callee's device (Android notifee + iOS CallKit).
    if (callFcm.configured()) void callFcm.sendCancel(active.receiverId, callId);
    if (callVoip.configured()) void callVoip.sendCancel(active.receiverId, callId);
  },

  // GET /calls/history
  async history(userId: string, page: HistoryPage): Promise<CallLogDTO[]> {
    const logs = await callLogRepo.history(userId, page);
    const peerIds = logs.map((l) => (l.callerId === userId ? l.receiverId : l.callerId));
    const names = await resolveNames(peerIds);
    return logs.map((l) => {
      const peerId = l.callerId === userId ? l.receiverId : l.callerId;
      return toCallLogDTO(l, userId, names.get(peerId) ?? 'Unknown');
    });
  },

  // GET /calls/:id — participant-only.
  async getById(userId: string, id: string): Promise<CallLogDTO> {
    const log = await callLogRepo.byId(id);
    if (!log) throw NotFound('Call not found');
    if (log.callerId !== userId && log.receiverId !== userId) throw Forbidden('Not a participant of this call');
    const peerId = log.callerId === userId ? log.receiverId : log.callerId;
    const names = await resolveNames([peerId]);
    return toCallLogDTO(log, userId, names.get(peerId) ?? 'Unknown');
  },

  // GET /calls/analytics — admin reporting.
  async analytics(filter: AnalyticsFilter) {
    const [summary, daily, monthly, perUser] = await Promise.all([
      callAnalyticsRepo.summary(filter),
      callAnalyticsRepo.buckets(filter, 'day'),
      callAnalyticsRepo.buckets(filter, 'month'),
      callAnalyticsRepo.perUser(filter),
    ]);
    const names = await resolveNames(perUser.map((p) => p.userId));
    return {
      summary,
      daily,
      monthly,
      perUser: perUser.map((p) => ({ ...p, name: names.get(p.userId) ?? 'Unknown' })),
    };
  },
};
