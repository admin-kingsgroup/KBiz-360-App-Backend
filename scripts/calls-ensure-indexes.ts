/* eslint-disable no-console */
// Creates/repairs the audio-calling collections' indexes in kb360_app:
//   • call_logs    — { callerId, createdAt }, { receiverId, createdAt }, { status }, { createdAt }
//   • active_calls — unique { callId }, { callerId }, { receiverId }, TTL { expiresAt }
//   • push_devices — { userId }, unique { expoPushToken }
// Boot also runs this (ensureCallIndexes in mongo/main.ts); use this for prod/migrations.
// Run: npx ts-node scripts/calls-ensure-indexes.ts
import 'dotenv/config';
import { connectMongo, disconnectMongo } from '../src/mongo/connection';
import { ensureCallIndexes } from '../src/mongo/calls/call.models';

async function main(): Promise<void> {
  await connectMongo();
  await ensureCallIndexes();
  console.log('[calls] indexes ensured on call_logs, active_calls (TTL), push_devices');
  await disconnectMongo();
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
