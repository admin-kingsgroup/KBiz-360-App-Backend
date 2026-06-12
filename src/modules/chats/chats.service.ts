import type { Chat as PChat, Message as PMessage } from '@prisma/client';
import { prisma } from '../../db/prisma';
import { NotFound, Forbidden } from '../../common/errors';
import { writeAudit } from '../../common/audit';
import { emitToChat, SOCKET_EVENTS } from '../../realtime/socket';

function mapChat(c: PChat, unread: number) {
  return {
    id: c.id,
    kind: c.kind,
    name: c.name,
    bizId: c.bizId ?? undefined,
    branchCode: c.branchCode ?? undefined,
    preview: c.preview ?? undefined,
    online: c.online ?? undefined,
    ts: c.lastMessageAt ? c.lastMessageAt.getTime() : 0,
    unread,
  };
}

function mapMessage(m: PMessage) {
  return { id: m.id, chatId: m.chatId, senderId: m.senderId, body: m.body, status: m.status, ts: m.createdAt.getTime() };
}

// Source sort: unread chats first, then most recent (mirrors chatStore.sortedChats / data.sortChats).
function sortChats<T extends { unread: number; ts: number }>(list: T[]): T[] {
  return [...list].sort((a, b) => ((b.unread || 0) > 0 ? 1 : 0) - ((a.unread || 0) > 0 ? 1 : 0) || (b.ts || 0) - (a.ts || 0));
}

export const chatsService = {
  // GET /chats — the DM list is GLOBAL and NOT access-filtered (source-faithful). Self-exclusion is
  // by name (the signed-in user's own DM entry is hidden). Unread comes from the caller's participant.
  async list(userId: string) {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw Forbidden('Session user not found');
    const chats = await prisma.chat.findMany();
    const myParts = await prisma.chatParticipant.findMany({ where: { userId } });
    const unreadByChat = new Map(myParts.map((p) => [p.chatId, p.unread] as const));

    const list = sortChats(
      chats
        .filter((c) => c.name !== user.name) // self-exclusion (caller responsibility in the app)
        .map((c) => mapChat(c, unreadByChat.get(c.id) ?? 0)),
    );
    const unreadTotal = myParts.reduce((n, p) => n + (p.unread || 0), 0);
    return { chats: list, unreadTotal };
  },

  async messages(chatId: string) {
    const chat = await prisma.chat.findUnique({ where: { id: chatId } });
    if (!chat) throw NotFound('Chat not found');
    const rows = await prisma.message.findMany({ where: { chatId }, orderBy: { createdAt: 'asc' } });
    return rows.map(mapMessage);
  },

  // POST /chats/:id/read — mark the caller's unread for this chat to 0 (mirrors chatStore.markRead).
  async markRead(userId: string, chatId: string) {
    const chat = await prisma.chat.findUnique({ where: { id: chatId } });
    if (!chat) throw NotFound('Chat not found');
    await prisma.chatParticipant.upsert({
      where: { chatId_userId: { chatId, userId } },
      update: { unread: 0, lastReadAt: new Date() },
      create: { chatId, userId, unread: 0, lastReadAt: new Date() },
    });
    emitToChat(chatId, SOCKET_EVENTS.MESSAGE_READ, { chatId, userId });
  },

  // POST /messages — append a message, bump the chat, increment unread for OTHER participants,
  // and broadcast message:new to the room.
  async postMessage(userId: string, chatId: string, body: string) {
    const chat = await prisma.chat.findUnique({ where: { id: chatId } });
    if (!chat) throw NotFound('Chat not found');

    const message = await prisma.message.create({ data: { chatId, senderId: userId, body } });
    await prisma.chat.update({ where: { id: chatId }, data: { lastMessageAt: message.createdAt, preview: body } });
    await prisma.chatParticipant.updateMany({
      where: { chatId, userId: { not: userId } },
      data: { unread: { increment: 1 } },
    });

    const dto = mapMessage(message);
    emitToChat(chatId, SOCKET_EVENTS.MESSAGE_NEW, dto);
    await writeAudit({ actorId: userId, action: 'CREATE', entity: 'Message', entityId: message.id });
    return dto;
  },
};
