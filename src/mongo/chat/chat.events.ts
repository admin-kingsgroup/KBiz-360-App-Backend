import type { Server } from 'socket.io';

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

// ── presence ──
const onlineCounts = new Map<string, number>();
const lastSeenAt = new Map<string, Date>();

export function markOnline(userId: string): boolean {
  const was = (onlineCounts.get(userId) ?? 0) > 0;
  onlineCounts.set(userId, (onlineCounts.get(userId) ?? 0) + 1);
  return !was; // true if this is the first connection (became online)
}
export function markOffline(userId: string): boolean {
  const n = (onlineCounts.get(userId) ?? 1) - 1;
  if (n <= 0) {
    onlineCounts.delete(userId);
    lastSeenAt.set(userId, new Date());
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
