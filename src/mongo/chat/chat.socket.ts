import type { Server, Socket } from 'socket.io';
import { verifyAccess } from '../../modules/auth/jwt';
import { setChatIO, userRoom, convRoom, markOnline, markOffline, getLastSeen, broadcastPresence } from './chat.events';
import { chatService, CHAT_EVENTS } from './chat.service';

// Registers the chat realtime layer on the shared Socket.IO server. Authenticates via the
// handshake access token, manages presence, conversation rooms, typing, and read/delivered/send.
export function registerChatHandlers(io: Server): void {
  setChatIO(io);

  io.on('connection', (socket: Socket) => {
    const token = (socket.handshake.auth as { token?: string } | undefined)?.token;
    let userId: string | null = null;
    try {
      if (token) userId = verifyAccess(token).sub;
    } catch {
      userId = null;
    }
    if (!userId) {
      // Tell the client its token failed (so it can refresh/re-login) instead of leaving a zombie
      // socket whose presence and receipts silently freeze.
      socket.emit('auth:invalid');
      socket.disconnect(true);
      return;
    }
    void socket.join(userRoom(userId));
    // Delivered-on-connect sweep: double-tick everything pending for this user, WhatsApp-style.
    void chatService.markDeliveredEverywhere(userId).catch(() => undefined);

    if (markOnline(userId)) {
      io.emit(CHAT_EVENTS.ONLINE, { userId });
      broadcastPresence(userId); // unified 'presence:update' (used by calling/presence features)
    }

    socket.on('chat:join', async (p: { conversationId?: string }) => {
      if (!p?.conversationId) return;
      try {
        await chatService.assertAccess(userId!, p.conversationId);
        void socket.join(convRoom(p.conversationId));
        await chatService.markDelivered(userId!, p.conversationId);
      } catch {
        /* not a member — ignore */
      }
    });
    socket.on('chat:leave', (p: { conversationId?: string }) => {
      if (p?.conversationId) void socket.leave(convRoom(p.conversationId));
    });

    socket.on('chat:typing', (p: { conversationId?: string }) => {
      if (p?.conversationId) socket.to(convRoom(p.conversationId)).emit(CHAT_EVENTS.TYPING, { conversationId: p.conversationId, userId });
    });
    socket.on('chat:stopTyping', (p: { conversationId?: string }) => {
      if (p?.conversationId) socket.to(convRoom(p.conversationId)).emit(CHAT_EVENTS.STOP_TYPING, { conversationId: p.conversationId, userId });
    });

    socket.on('chat:read', async (p: { conversationId?: string }) => {
      if (p?.conversationId) await chatService.markRead(userId!, p.conversationId).catch(() => undefined);
    });
    socket.on('chat:delivered', async (p: { conversationId?: string }) => {
      if (p?.conversationId) await chatService.markDelivered(userId!, p.conversationId).catch(() => undefined);
    });

    // Send via socket (with ack) — mirrors the REST POST /messages and emits chat:receive.
    socket.on('chat:send', async (p: { conversationId: string; type?: 'text' | 'image' | 'video' | 'document' | 'voice'; text?: string; replyToId?: string; clientId?: string }, ack?: (r: unknown) => void) => {
      try {
        const dto = await chatService.sendMessage(userId!, p.conversationId, p);
        ack?.({ ok: true, message: dto });
      } catch (e) {
        ack?.({ ok: false, error: (e as Error).message });
      }
    });

    // Custom presence status (Busy / In Meeting / In Call).
    socket.on('chat:presence', (p: { status?: string }) => {
      io.emit(CHAT_EVENTS.ONLINE, { userId, status: p?.status ?? 'online' });
    });

    socket.on('disconnect', () => {
      if (markOffline(userId!)) {
        io.emit(CHAT_EVENTS.OFFLINE, { userId, lastSeen: getLastSeen(userId!)?.getTime() ?? null }); // epoch ms, never a raw Date
        broadcastPresence(userId!); // unified 'presence:update'
      }
    });
  });
}
