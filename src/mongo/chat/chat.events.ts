import type { Server } from 'socket.io';
import { UserPresenceModel } from './presence.model';

// Holds the Socket.IO server + in-memory presence so the service/REST layer can emit realtime
// events without importing the socket module (avoids a cycle). Presence is per-instance; for
// multi-instance scale, back it with the @socket.io/redis-adapter + a shared presence store.
let io: Server | null = null;
export const setChatIO = (s: Server): void => { io = s; };

export const userRoom = (userId: string): string => `user:${userId}`;
export const convRoom = (conversationId: string): string => `conv:${conversationId}`;

export function emitToUser(userId: string, event: string, payload: unknown): void {
  io?.to(userRoom(userId)).emit(event, payload);
}
export function emitToUsers(userIds: string[], event: string, payload: unknown): void {
  for (const id of userIds) emitToUser(id, event, payload);
}
export function emitToConversation(conversationId: string, event: string, payload: unknown): void {
  io?.to(convRoom(conversationId)).emit(event, payload);
}
// Broadcast to every connected client. Keep payloads to bare ids — receivers refetch through
// access-filtered REST endpoints, so broadcasting never widens what a user can actually read.
export function emitToAll(event: string, payload: unknown): void {
  io?.emit(event, payload);
}

// ── presence ──
// The Map is the synchronous read path; user_presence is its durability (see presence.model.ts).
const onlineCounts = new Map<string, number>();
const lastSeenAt = new Map<string, Date>();

// Fire-and-forget durability for last-seen — presence writes must never crash a handler
// (appDb() throws synchronously when Mongo is down, hence the try around the query build too).
function persistLastSeen(userId: string, at: Date): void {
  try {
    void UserPresenceModel().updateOne({ _id: userId }, { $set: { lastSeenAt: at } }, { upsert: true }).exec().catch(() => undefined);
  } catch { /* not connected — best-effort */ }
}

// Load persisted last-seen into the Map at boot so "last seen" survives restarts.
export async function hydratePresence(): Promise<void> {
  const docs = await UserPresenceModel().find({}).select('_id lastSeenAt').lean<{ _id: string; lastSeenAt: Date }[]>();
  for (const d of docs) if (d.lastSeenAt) lastSeenAt.set(String(d._id), new Date(d.lastSeenAt));
}

// 60s heartbeat: bulk-stamp lastSeenAt for everyone online so a crash loses ≤60s of accuracy.
let heartbeat: ReturnType<typeof setInterval> | null = null;
export function startPresenceHeartbeat(intervalMs = 60_000): void {
  if (heartbeat) return;
  heartbeat = setInterval(() => {
    const ids = onlineUserIds();
    if (!ids.length) return;
    const now = new Date();
    try {
      void UserPresenceModel()
        .bulkWrite(ids.map((id) => ({ updateOne: { filter: { _id: id }, update: { $set: { lastSeenAt: now } }, upsert: true } })), { ordered: false })
        .catch(() => undefined);
    } catch { /* not connected — best-effort */ }
  }, intervalMs);
  heartbeat.unref(); // never keep tests/shutdown alive
}
export function stopPresenceHeartbeat(): void {
  if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
}

export function markOnline(userId: string): boolean {
  const was = (onlineCounts.get(userId) ?? 0) > 0;
  onlineCounts.set(userId, (onlineCounts.get(userId) ?? 0) + 1);
  persistLastSeen(userId, new Date()); // stamp on connect too — crash while online stays ≤60s stale
  return !was; // true if this is the first connection (became online)
}
export function markOffline(userId: string): boolean {
  const n = (onlineCounts.get(userId) ?? 1) - 1;
  if (n <= 0) {
    onlineCounts.delete(userId);
    const at = new Date();
    lastSeenAt.set(userId, at);
    persistLastSeen(userId, at);
    return true; // became offline
  }
  onlineCounts.set(userId, n);
  return false;
}
export const isOnline = (userId: string): boolean => (onlineCounts.get(userId) ?? 0) > 0;
export const getLastSeen = (userId: string): Date | null => lastSeenAt.get(userId) ?? null;
export const onlineUserIds = (): string[] => [...onlineCounts.keys()];

// ── presence status incl. "in call" (precedence: in_call > online > offline) ──
export type PresenceStatus = 'online' | 'offline' | 'in_call';
const inCall = new Set<string>();

export function setInCall(userId: string, value: boolean): void {
  if (value) inCall.add(userId);
  else inCall.delete(userId);
}
export function presenceStatusOf(userId: string): PresenceStatus {
  if (inCall.has(userId)) return 'in_call';
  return isOnline(userId) ? 'online' : 'offline';
}

// Broadcast a user's current presence to all connected clients (small team; for scale, scope to
// the user's contacts via a presence room + the redis adapter).
export function broadcastPresence(userId: string): void {
  io?.emit('presence:update', {
    userId,
    status: presenceStatusOf(userId),
    lastSeen: getLastSeen(userId)?.getTime() ?? null,
  });
}
