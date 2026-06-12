import { Queue, Worker, type Job } from 'bullmq';
import { queueConnection, QUEUES } from './index';
import { prisma } from '../db/prisma';
import { config } from '../config';
import { writeAudit } from '../common/audit';

export interface PushJob {
  userId: string;
  notificationId: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
}

// Expo push token format (validated without the ESM-only expo-server-sdk).
const isExpoPushToken = (t: string): boolean => /^Expo(nent)?PushToken\[[^\]]+\]$/.test(t);
const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

let queue: Queue<PushJob> | null = null;
export function pushQueue(): Queue<PushJob> {
  if (!queue) queue = new Queue<PushJob>(QUEUES.PUSH, { connection: queueConnection });
  return queue;
}

// Enqueue resiliently — if Redis is unavailable, log and continue (the Notification row still exists).
export async function enqueuePush(job: PushJob): Promise<boolean> {
  try {
    await pushQueue().add('send', job, { removeOnComplete: true, removeOnFail: 100 });
    return true;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[push] enqueue failed:', (err as Error).message);
    return false;
  }
}

// POST a batch to the Expo Push API (≤100 per request). Plain fetch — no SDK (CJS-safe).
async function sendToExpo(messages: Array<{ to: string; title: string; body: string; data: Record<string, unknown> }>): Promise<void> {
  for (let i = 0; i < messages.length; i += 100) {
    const chunk = messages.slice(i, i + 100);
    try {
      await fetch(EXPO_PUSH_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          ...(config.push.expoAccessToken ? { Authorization: `Bearer ${config.push.expoAccessToken}` } : {}),
        },
        body: JSON.stringify(chunk),
      });
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[push] send error:', (e as Error).message);
    }
  }
}

// Deliver one job: load the user's Expo tokens and send (dry-run unless EXPO_PUSH_ENABLED=true).
// Always records a PUSH_DELIVERED audit row so delivery is observable end-to-end.
async function deliver(job: PushJob): Promise<{ tokens: number }> {
  const devices = await prisma.device.findMany({ where: { userId: job.userId } });
  const tokens = devices.map((d) => d.expoPushToken).filter(isExpoPushToken);

  if (config.push.enabled && tokens.length) {
    await sendToExpo(tokens.map((to) => ({ to, title: job.title, body: job.body, data: job.data ?? {} })));
  }

  await writeAudit({
    actorId: null,
    action: 'PUSH_DELIVERED',
    entity: 'Notification',
    entityId: job.notificationId,
    after: { tokens: tokens.length, dryRun: !config.push.enabled },
  });
  return { tokens: tokens.length };
}

let worker: Worker<PushJob> | null = null;
export function startPushWorker(): Worker<PushJob> {
  if (!worker) {
    worker = new Worker<PushJob>(QUEUES.PUSH, async (job: Job<PushJob>) => deliver(job.data), { connection: queueConnection });
  }
  return worker;
}

export async function stopPush(): Promise<void> {
  if (worker) {
    await worker.close();
    worker = null;
  }
  if (queue) {
    await queue.close();
    queue = null;
  }
}
