import IORedis from 'ioredis';
import { prisma } from '../../../db/prisma';
import { config } from '../../../config';
import { notificationsService } from '../notifications.service';
import { startPushWorker, stopPush } from '../../../queue/push';

// BullMQ — proves enqueue → worker → delivery end-to-end against Redis. Writes a PUSH_DELIVERED
// audit row (dry-run send). Self-skips without DB or Redis. Uses user a2 to avoid clashing with
// the notifications integration suite (which uses a1).
const FARHAN = 'a2';
const TOKEN = 'ExponentPushToken[test-queue-a2]';

let dbReady = false;
let redisReady = false;
let worker: ReturnType<typeof startPushWorker> | null = null;

async function waitFor<T>(fn: () => Promise<T>, timeoutMs: number): Promise<T> {
  const start = Date.now();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) return v;
    await new Promise((r) => setTimeout(r, 150));
  }
}

beforeAll(async () => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    const a = await prisma.user.findFirst({ where: { id: FARHAN } });
    dbReady = Boolean(a);
  } catch {
    /* skip */
  }
  // Probe Redis.
  const probe = new IORedis({ host: config.redis.host, port: config.redis.port, lazyConnect: true, maxRetriesPerRequest: 1 });
  try {
    await probe.connect();
    await probe.ping();
    redisReady = true;
  } catch {
    redisReady = false;
  } finally {
    probe.disconnect();
  }

  if (dbReady && redisReady) {
    await prisma.notification.deleteMany({ where: { userId: FARHAN } });
    await prisma.device.deleteMany({ where: { userId: FARHAN } });
    await prisma.device.create({ data: { userId: FARHAN, expoPushToken: TOKEN } });
    worker = startPushWorker();
  } else {
    // eslint-disable-next-line no-console
    console.warn(`[notifications.queue] skipping — dbReady=${dbReady} redisReady=${redisReady}`);
  }
});

afterAll(async () => {
  await stopPush();
  if (dbReady) {
    await prisma.notification.deleteMany({ where: { userId: FARHAN } });
    await prisma.device.deleteMany({ where: { userId: FARHAN } });
  }
  await prisma.$disconnect();
});

describe('Notifications push queue (BullMQ + Redis)', () => {
  it('enqueued push job is processed by the worker → PUSH_DELIVERED audit', async () => {
    if (!dbReady || !redisReady) return;
    const n = await notificationsService.notify(FARHAN, { title: 'QT', body: 'QB', data: { type: 'chat', id: 'u3' } });
    const audit = await waitFor(
      () => prisma.auditLog.findFirst({ where: { action: 'PUSH_DELIVERED', entityId: n.id } }),
      8000,
    );
    expect(audit).toBeTruthy();
    expect((audit!.after as { tokens: number }).tokens).toBe(1); // a2's registered token, dry-run
  }, 15000);
});
