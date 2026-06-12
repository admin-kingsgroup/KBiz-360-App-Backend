import { z } from 'zod';
import type { ActiveCallDoc, CallLogDoc, CallMediaType, CallLogStatus } from './call.models';

// ───────────────────────── Socket event names (shared contract with the app) ─────────────────────────
export const CALL_EVENTS = {
  // server → client (lifecycle; REST is authoritative, server fans these out)
  INCOMING: 'call:incoming',
  ACCEPTED: 'call:accept',
  REJECTED: 'call:reject',
  ENDED: 'call:end',
  MISSED: 'call:missed',
  // client ↔ client relay (WebRTC media negotiation; server only forwards to the peer)
  OFFER: 'call:offer',
  ANSWER: 'call:answer',
  ICE: 'call:ice-candidate',
  // presence
  PRESENCE_UPDATE: 'presence:update',
} as const;

export type PresenceStatus = 'online' | 'offline' | 'in_call';

// ───────────────────────── DTOs (wire shapes) ─────────────────────────
export interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export interface CallParticipant {
  id: string;
  name: string;
}

// A live call as seen by a client (initiate response + call:incoming payload).
export interface CallDTO {
  callId: string;
  type: CallMediaType;
  status: ActiveCallDoc['status'];
  caller: CallParticipant;
  receiver: CallParticipant;
  startedAt: number;
}

// A history row, oriented to the requesting viewer (direction + the "other" person).
export interface CallLogDTO {
  id: string;
  callId: string;
  type: CallMediaType;
  status: CallLogStatus;
  direction: 'incoming' | 'outgoing';
  peer: CallParticipant; // the other party from the viewer's perspective
  startedAt: number;
  endedAt: number;
  durationSec: number;
}

// ── server → client payloads ──
export interface IncomingCallPayload { callId: string; type: CallMediaType; caller: CallParticipant; startedAt: number }
export interface CallAcceptedPayload { callId: string }
export interface CallRejectedPayload { callId: string }
export interface CallEndedPayload { callId: string; endedBy: string | null; status: CallLogStatus; durationSec: number }
export interface CallMissedPayload { callId: string }
export interface PresenceUpdatePayload { userId: string; status: PresenceStatus; lastSeen: number | null }

// ── client ↔ client relay payload (offer/answer/ice). `to` is the peer userId. ──
export interface SignalPayload {
  callId: string;
  to: string;
  // exactly one of these is set depending on the event
  sdp?: { type: string; sdp: string };
  candidate?: unknown;
}

// ───────────────────────── Validation (zod) ─────────────────────────
export const initiateSchema = z.object({
  receiverId: z.string().min(1),
  type: z.enum(['voice', 'video']).default('voice'),
});
export const callIdSchema = z.object({ callId: z.string().min(1) });
export const registerDeviceSchema = z.object({
  expoPushToken: z.string().min(1),
  platform: z.string().optional(),
});
export const historyQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  before: z.string().optional(), // call_log _id cursor
});
export const analyticsQuerySchema = z.object({
  from: z.coerce.number().int().optional(), // ms epoch
  to: z.coerce.number().int().optional(),
  userId: z.string().optional(),
});

// ───────────────────────── Mappers ─────────────────────────
export function toCallDTO(active: ActiveCallDoc, callerName: string, receiverName: string): CallDTO {
  return {
    callId: active.callId,
    type: active.type,
    status: active.status,
    caller: { id: active.callerId, name: callerName },
    receiver: { id: active.receiverId, name: receiverName },
    startedAt: active.startedAt.getTime(),
  };
}

export function toCallLogDTO(log: CallLogDoc, viewerId: string, peerName: string): CallLogDTO {
  const outgoing = log.callerId === viewerId;
  return {
    id: String(log._id),
    callId: log.callId,
    type: log.type,
    status: log.status,
    direction: outgoing ? 'outgoing' : 'incoming',
    peer: { id: outgoing ? log.receiverId : log.callerId, name: peerName },
    startedAt: log.startedAt.getTime(),
    endedAt: log.endedAt.getTime(),
    durationSec: log.durationSec,
  };
}
