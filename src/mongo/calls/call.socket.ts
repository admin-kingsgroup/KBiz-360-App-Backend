import type { Server, Socket } from 'socket.io';
import { verifyAccess } from '../../modules/auth/jwt';
import { emitToUser, userRoom } from '../chat/chat.events';
import { activeCallRepo } from './call.repository';
import { crmRepo } from '../crm.repo';
import { CALL_EVENTS, type SignalPayload } from './call.types';

// Registers the WebRTC media-signaling relay on the shared Socket.IO server. The call LIFECYCLE
// (initiate/accept/reject/end) is authoritative over REST — here we only forward SDP offers/answers
// and ICE candidates between the two verified parties of a live call. Presence is owned by the chat
// socket layer (markOnline/markOffline); we just reuse the per-user rooms it relies on.
export function registerCallHandlers(io: Server): void {
  io.on('connection', (socket: Socket) => {
    const token = (socket.handshake.auth as { token?: string } | undefined)?.token;
    let userId: string | null = null;
    try {
      if (token) userId = verifyAccess(token).sub;
    } catch {
      userId = null;
    }
    if (!userId) return; // unauthenticated sockets cannot signal
    void socket.join(userRoom(userId)); // idempotent — guarantees signaling works independent of chat

    // Re-deliver a still-ringing incoming call on (re)connect. Covers the app-was-killed case: the
    // callee taps the push, the app relaunches + reconnects, and the incoming-call UI appears.
    void (async () => {
      const active = await activeCallRepo.activeForUser(userId!);
      if (active && active.status === 'ringing' && active.receiverId === userId) {
        const caller = await crmRepo.getUserById(active.callerId);
        const name = caller ? `${caller.first_name ?? ''} ${caller.last_name ?? ''}`.trim() || caller.email : 'Unknown';
        emitToUser(userId!, CALL_EVENTS.INCOMING, { callId: active.callId, type: active.type, caller: { id: active.callerId, name }, startedAt: active.startedAt.getTime() });
      }
    })();

    // Relay one signaling message to the peer, but only if both ends are the parties of a real,
    // active call (prevents spoofing / unsolicited SDP to arbitrary users).
    const relay = (event: typeof CALL_EVENTS.OFFER | typeof CALL_EVENTS.ANSWER | typeof CALL_EVENTS.ICE) =>
      async (p: SignalPayload): Promise<void> => {
        if (!p?.callId || !p?.to) return;
        const active = await activeCallRepo.byCallId(p.callId);
        if (!active) return;
        const parties = [active.callerId, active.receiverId];
        if (!parties.includes(userId!) || !parties.includes(p.to)) return;
        emitToUser(p.to, event, { callId: p.callId, from: userId, sdp: p.sdp, candidate: p.candidate });
      };

    socket.on(CALL_EVENTS.OFFER, (p: SignalPayload) => void relay(CALL_EVENTS.OFFER)(p));
    socket.on(CALL_EVENTS.ANSWER, (p: SignalPayload) => void relay(CALL_EVENTS.ANSWER)(p));
    socket.on(CALL_EVENTS.ICE, (p: SignalPayload) => void relay(CALL_EVENTS.ICE)(p));
  });
}
