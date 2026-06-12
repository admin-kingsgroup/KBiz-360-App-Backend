import { Queue, QueueOptions } from 'bullmq';
import { config } from '../config';

// BullMQ foundation. A single Redis connection config is shared by all queues. Push-notification
// delivery (Expo) and email (Resend) are enqueued here in the Notifications phase. Workers are
// registered per-queue in their owning module. Nothing connects to Redis until a queue is used.
export const queueConnection: QueueOptions['connection'] = {
  host: config.redis.host,
  port: config.redis.port,
};

export const QUEUES = {
  PUSH: 'push-delivery',
  EMAIL: 'email-delivery',
} as const;

let pushQueue: Queue | null = null;

// Lazily construct the push queue so importing this module never opens a Redis socket.
export function getPushQueue(): Queue {
  if (!pushQueue) {
    pushQueue = new Queue(QUEUES.PUSH, { connection: queueConnection });
  }
  return pushQueue;
}
