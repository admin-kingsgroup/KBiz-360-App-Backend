import { Server as HttpServer } from 'http';
import { Server as IOServer, Socket } from 'socket.io';
import { verifyAccess } from '../modules/auth/jwt';

// Socket.IO realtime. Event contract mirrors the frontend chatStore semantics.
//   Client → server : 'chat:join', 'chat:leave', 'chat:typing'
//   Server → client : 'message:new', 'message:read', 'chat:typing'
export const SOCKET_EVENTS = {
  MESSAGE_NEW: 'message:new',
  MESSAGE_READ: 'message:read',
  CHAT_TYPING: 'chat:typing',
} as const;

const room = (chatId: string): string => `chat:${chatId}`;

let io: IOServer | null = null;

export function initRealtime(httpServer: HttpServer): IOServer {
  // Tighter heartbeat so a dead socket (app killed/backgrounded) is detected in ~15s instead of the
  // ~45s default — keeps presence/last-seen and call-vs-push fallback accurate.
  io = new IOServer(httpServer, { cors: { origin: '*' }, pingInterval: 10000, pingTimeout: 5000 });

  io.on('connection', (socket: Socket) => {
    // Optional auth: a valid access token in the handshake identifies the socket's user.
    let userId: string | null = null;
    const token = (socket.handshake.auth as { token?: string } | undefined)?.token;
    if (token) {
      try {
        userId = verifyAccess(token).sub;
      } catch {
        userId = null;
      }
    }

    socket.on('chat:join', (payload: { chatId?: string }) => {
      if (payload?.chatId) void socket.join(room(payload.chatId));
    });
    socket.on('chat:leave', (payload: { chatId?: string }) => {
      if (payload?.chatId) void socket.leave(room(payload.chatId));
    });
    socket.on('chat:typing', (payload: { chatId?: string }) => {
      if (payload?.chatId) socket.to(room(payload.chatId)).emit(SOCKET_EVENTS.CHAT_TYPING, { chatId: payload.chatId, userId });
    });

    socket.on('disconnect', () => {
      /* no-op */
    });
  });

  return io;
}

export function getIO(): IOServer | null {
  return io;
}

// Emit an event to everyone in a chat room (used by the REST layer after a message / read).
export function emitToChat(chatId: string, event: string, payload: unknown): void {
  io?.to(room(chatId)).emit(event, payload);
}
