/* eslint-disable no-console */
// Recomputes every non-system message's AGGREGATE receipt status (WhatsApp semantics: 'read' once
// every other participant read, 'delivered' once every other participant has it) from its
// deliveredTo/readBy sets vs the conversation's CURRENT participantIds. MONOTONIC: a stored status
// is never downgraded and deliveredAt/readAt are only filled when null. DRY-RUN by default.
// Run: npx ts-node scripts/backfill-receipt-status.ts           (report would-change counts)
//      npx ts-node scripts/backfill-receipt-status.ts --apply   (write)
import 'dotenv/config';
import { connectMongo, disconnectMongo } from '../src/mongo/connection';
import { ConversationModel, MessageModel } from '../src/mongo/chat/chat.models';
import { aggregateStatus, type ReceiptStatus } from '../src/mongo/chat/chat.repository';

const APPLY = process.argv.includes('--apply');
const BATCH = 500;
const RANK: Record<ReceiptStatus, number> = { sent: 0, delivered: 1, read: 2 };
type BulkOps = Parameters<ReturnType<typeof MessageModel>['bulkWrite']>[0];

async function main(): Promise<void> {
  await connectMongo();
  const convs = await ConversationModel().find({}).select('_id participantIds').lean();
  const rosters = new Map(convs.map((c) => [String(c._id), c.participantIds ?? []]));
  console.log(`[backfill-receipts] ${convs.length} conversations, mode=${APPLY ? 'APPLY' : 'DRY-RUN'}`);

  let scanned = 0;
  let orphaned = 0;
  let changed = 0;
  const transitions: Record<string, number> = {};
  let ops: BulkOps = [];
  const flush = async (): Promise<void> => {
    if (APPLY && ops.length) await MessageModel().bulkWrite(ops, { ordered: false });
    ops = [];
  };

  const cursor = MessageModel()
    .find({ type: { $ne: 'system' } })
    .select('_id conversationId senderId deliveredTo readBy status deliveredAt readAt')
    .lean()
    .cursor();
  for await (const m of cursor) {
    scanned++;
    const roster = rosters.get(String(m.conversationId));
    if (!roster || !roster.length) { orphaned++; continue; } // conversation gone — leave the message alone
    const cur: ReceiptStatus = m.status ?? 'sent';
    const agg = aggregateStatus(m, roster);
    if (RANK[agg] <= RANK[cur]) continue; // monotonic — never downgrade a tick
    changed++;
    transitions[`${cur}→${agg}`] = (transitions[`${cur}→${agg}`] ?? 0) + 1;
    // Best historical timestamps we have: latest read receipt for readAt, else now.
    const readTimes = (m.readBy ?? []).map((r) => (r.at ? new Date(r.at).getTime() : 0)).filter(Boolean);
    const readAt = readTimes.length ? new Date(Math.max(...readTimes)) : new Date();
    const set: Record<string, unknown> = { status: agg };
    if (!m.deliveredAt) set.deliveredAt = agg === 'read' ? readAt : new Date();
    if (agg === 'read' && !m.readAt) set.readAt = readAt;
    ops.push({ updateOne: { filter: { _id: m._id }, update: { $set: set } } });
    if (ops.length >= BATCH) await flush();
  }
  await flush();

  console.log(`[backfill-receipts] scanned=${scanned} orphaned=${orphaned} ${APPLY ? 'changed' : 'would-change'}=${changed}`);
  for (const [t, n] of Object.entries(transitions)) console.log(`[backfill-receipts]   ${t}: ${n}`);
  if (!APPLY && changed) console.log('[backfill-receipts] dry-run — re-run with --apply to write.');
  await disconnectMongo();
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
