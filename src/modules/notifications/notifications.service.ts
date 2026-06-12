import type { Prisma } from '@prisma/client';
import { prisma } from '../../db/prisma';
import { NotFound, BadRequest, Forbidden } from '../../common/errors';
import { writeAudit } from '../../common/audit';
import { enqueuePush } from '../../queue/push';

function mapNotification(n: { id: string; title: string; body: string; data: Prisma.JsonValue; read: boolean; createdAt: Date }) {
  return { id: n.id, title: n.title, body: n.body, data: n.data ?? undefined, read: n.read, ts: n.createdAt.getTime() };
}

export const notificationsService = {
  // POST /notifications/register-device — upsert by token (re-registering moves it to this user).
  async registerDevice(userId: string, input: { expoPushToken: string; platform?: string }) {
    const device = await prisma.device.upsert({
      where: { expoPushToken: input.expoPushToken },
      update: { userId, platform: input.platform ?? null },
      create: { userId, expoPushToken: input.expoPushToken, platform: input.platform ?? null },
    });
    await writeAudit({ actorId: userId, action: 'REGISTER_DEVICE', entity: 'Device', entityId: device.id });
    return { id: device.id, expoPushToken: device.expoPushToken, platform: device.platform };
  },

  // GET /notifications — newest first.
  async list(userId: string) {
    const rows = await prisma.notification.findMany({ where: { userId }, orderBy: { createdAt: 'desc' } });
    return rows.map(mapNotification);
  },

  // POST /notifications/read — mark one (id) or all unread for the user.
  async markRead(userId: string, input: { id?: string; all?: boolean }) {
    if (input.all) {
      const res = await prisma.notification.updateMany({ where: { userId, read: false }, data: { read: true } });
      return { updated: res.count };
    }
    if (!input.id) throw BadRequest('Provide { id } or { all: true }');
    const n = await prisma.notification.findUnique({ where: { id: input.id } });
    if (!n) throw NotFound('Notification not found');
    if (n.userId !== userId) throw Forbidden('Not your notification');
    await prisma.notification.update({ where: { id: input.id }, data: { read: true } });
    return { updated: 1 };
  },

  // Internal: create a notification row + enqueue push delivery (used by other modules, e.g. reminders).
  async notify(userId: string, input: { title: string; body: string; data?: Record<string, unknown> }) {
    const n = await prisma.notification.create({
      data: { userId, title: input.title, body: input.body, data: (input.data ?? undefined) as Prisma.InputJsonValue | undefined },
    });
    await enqueuePush({ userId, notificationId: n.id, title: input.title, body: input.body, data: input.data });
    return mapNotification(n);
  },
};
