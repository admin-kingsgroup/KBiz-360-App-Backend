import request from 'supertest';
import { createApp } from '../../../app';
import { prisma } from '../../../db/prisma';
import { notificationsService } from '../notifications.service';
import { stopPush } from '../../../queue/push';

// Integration — device registration + notification list/read (DB). Requires a seeded DB; self-skips.
const app = createApp();
const SUPER = { identifier: 'afshin@kbiz360.com', password: 'kbiz360' }; // a1
const TOKEN = 'ExponentPushToken[test-int-a1]';

let dbReady = false;
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const tok = async () => (await request(app).post('/api/auth/login').send(SUPER)).body.accessToken as string;

beforeAll(async () => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    const a = await prisma.user.findFirst({ where: { email: SUPER.identifier } });
    dbReady = Boolean(a?.passwordHash);
  } catch {
    /* skip */
  }
  if (dbReady) {
    await prisma.notification.deleteMany({ where: { userId: 'a1' } });
    await prisma.device.deleteMany({ where: { userId: 'a1' } });
  }
});

afterAll(async () => {
  if (dbReady) {
    await prisma.notification.deleteMany({ where: { userId: 'a1' } });
    await prisma.device.deleteMany({ where: { userId: 'a1' } });
  }
  await stopPush(); // close any lazily-opened queue connection
  await prisma.$disconnect();
});

describe('Notifications — device registration + list/read', () => {
  it('POST /register-device upserts the device', async () => {
    if (!dbReady) return;
    const res = await request(app).post('/api/notifications/register-device').set(auth(await tok())).send({ expoPushToken: TOKEN, platform: 'ios' });
    expect(res.status).toBe(200);
    expect(res.body.expoPushToken).toBe(TOKEN);
  });

  it('notify() creates a row that GET /notifications lists (unread, newest-first)', async () => {
    if (!dbReady) return;
    await notificationsService.notify('a1', { title: 'T1', body: 'B1', data: { type: 'reminder', id: 'r1' } });
    const res = await request(app).get('/api/notifications').set(auth(await tok()));
    expect(res.status).toBe(200);
    expect(res.body[0].title).toBe('T1');
    expect(res.body[0].read).toBe(false);
    expect(res.body[0].data).toEqual({ type: 'reminder', id: 'r1' });
  });

  it('POST /read { id } marks one read', async () => {
    if (!dbReady) return;
    const list = (await request(app).get('/api/notifications').set(auth(await tok()))).body;
    const id = list[0].id;
    const res = await request(app).post('/api/notifications/read').set(auth(await tok())).send({ id });
    expect(res.body.updated).toBe(1);
    const after = (await request(app).get('/api/notifications').set(auth(await tok()))).body;
    expect(after.find((n: { id: string }) => n.id === id).read).toBe(true);
  });

  it('POST /read { all } marks all unread read', async () => {
    if (!dbReady) return;
    await notificationsService.notify('a1', { title: 'T2', body: 'B2' });
    const t = await tok();
    const res = await request(app).post('/api/notifications/read').set(auth(t)).send({ all: true });
    expect(res.body.updated).toBeGreaterThanOrEqual(1);
    const after = (await request(app).get('/api/notifications').set(auth(t))).body;
    expect(after.every((n: { read: boolean }) => n.read)).toBe(true);
  });

  it('GET /notifications without auth → 401', async () => {
    if (!dbReady) return;
    expect((await request(app).get('/api/notifications')).status).toBe(401);
  });
});
