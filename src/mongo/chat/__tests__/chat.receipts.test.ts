import { Types } from 'mongoose';
import { connectMongo, disconnectMongo } from '../../connection';
import { ConversationModel, MessageModel, type ConversationDoc, type MessageDoc } from '../chat.models';
import { messageRepo } from '../chat.repository';
import { chatService } from '../chat.service';

// INTEGRATION: WhatsApp aggregate receipt semantics (group + direct) straight against Mongo, with
// synthetic participant ids (repo/service receipt paths never look users up in the CRM). No sockets:
// emitToUsers is a no-op here (io never set in this worker). Self-skips without Mongo; cleans up after.
let ready = false;
const run = `t${Date.now().toString(36)}`;
const u = (n: string): string => `test-receipts-${run}-${n}`;
const A = u('a');
const B = u('b');
const C = u('c');
const convIds: Types.ObjectId[] = [];

const member = (userId: string) => ({ userId, role: 'member' as const, joinedAt: new Date(), lastReadAt: null, unread: 0, muted: false, archived: false });
async function makeConv(type: 'direct' | 'group', participantIds: string[]): Promise<ConversationDoc> {
  const conv = await ConversationModel().create({
    type,
    participantIds,
    members: participantIds.map(member),
    createdBy: participantIds[0],
    lastActivityAt: new Date(),
    ...(type === 'direct' ? { directKey: [...participantIds].sort().join('|') } : { name: 'receipts test' }),
  });
  convIds.push(conv._id);
  return conv.toObject() as ConversationDoc;
}
async function makeMsg(conversationId: Types.ObjectId, senderId: string, type: MessageDoc['type'] = 'text') {
  return messageRepo.create({ conversationId, senderId, type, text: 'x', status: 'sent', sentAt: new Date(), deliveredTo: [senderId], readBy: [] });
}
const fetchMsg = async (id: Types.ObjectId) => (await MessageModel().findById(id).lean())!;

beforeAll(async () => {
  try {
    await connectMongo();
    ready = true;
  } catch {
    ready = false;
  }
}, 30000);

afterAll(async () => {
  if (ready && convIds.length) {
    await MessageModel().deleteMany({ conversationId: { $in: convIds } });
    await ConversationModel().deleteMany({ _id: { $in: convIds } });
  }
  await disconnectMongo();
}, 20000);

describe('Receipt aggregation — group of 3', () => {
  it('any delivery ⇒ delivered; any read ⇒ read (with first-reach scalars)', async () => {
    if (!ready) return;
    const conv = await makeConv('group', [A, B, C]);
    const cid = String(conv._id);
    const msg = await makeMsg(conv._id, A);
    const mid = String(msg._id);

    // C receives it — ONE member having it is enough for the grey double tick (B still pending).
    const d = await messageRepo.markDelivered(cid, C, conv.participantIds, new Date());
    expect(d.ids).toEqual([mid]);
    expect(d.statuses).toEqual([{ id: mid, status: 'delivered' }]);
    let doc = await fetchMsg(msg._id);
    expect(doc.status).toBe('delivered');
    expect(doc.deliveredAt).toBeTruthy();
    expect(doc.readAt).toBeNull();

    // B reads — ANY member reading flips the aggregate to 'read', even though C never read.
    const r = await messageRepo.markRead(cid, B, conv.participantIds, new Date());
    expect(r.statuses).toEqual([{ id: mid, status: 'read' }]);
    doc = await fetchMsg(msg._id);
    expect(doc.status).toBe('read');
    expect(doc.readAt).toBeTruthy();
  });

  it('one member reading flips a still-sent message straight to read (both scalars stamped)', async () => {
    if (!ready) return;
    const conv = await makeConv('group', [A, B, C]);
    const msg = await makeMsg(conv._id, A);
    // B reads while C hasn't even received it — the sender still gets the blue tick.
    const r = await messageRepo.markRead(String(conv._id), B, conv.participantIds, new Date());
    expect(r.statuses).toEqual([{ id: String(msg._id), status: 'read' }]);
    const doc = await fetchMsg(msg._id);
    expect(doc.status).toBe('read');
    expect(doc.deliveredAt).toBeTruthy(); // sent→read jump stamps delivery too
    expect(doc.readAt).toBeTruthy();
  });

  it('a late delivery receipt NEVER regresses a read tick (monotonic)', async () => {
    if (!ready) return;
    const conv = await makeConv('group', [A, B, C]);
    const msg = await makeMsg(conv._id, A);
    // Legacy-shaped state: stored 'read' although nobody is in readBy (so the recomputed
    // aggregate is only 'delivered') — the stored tick must not move down.
    await MessageModel().updateOne(
      { _id: msg._id },
      { $set: { status: 'read', readAt: new Date(), readBy: [], deliveredTo: [A, B] } },
    );
    const d = await messageRepo.markDelivered(String(conv._id), C, conv.participantIds, new Date());
    expect(d.statuses).toEqual([{ id: String(msg._id), status: 'read' }]);
    expect((await fetchMsg(msg._id)).status).toBe('read');
  });

  it('system messages carry no receipts', async () => {
    if (!ready) return;
    const conv = await makeConv('group', [A, B, C]);
    const sys = await makeMsg(conv._id, A, 'system');
    const r = await messageRepo.markRead(String(conv._id), B, conv.participantIds, new Date());
    expect(r.ids).toHaveLength(0);
    const doc = await fetchMsg(sys._id);
    expect(doc.readBy).toHaveLength(0);
    expect(doc.status).toBe('sent');
  });
});

describe('Receipt aggregation — direct', () => {
  it('the single recipient reading ⇒ read immediately', async () => {
    if (!ready) return;
    const conv = await makeConv('direct', [A, B]);
    const msg = await makeMsg(conv._id, A);
    const r = await chatService.markRead(B, String(conv._id));
    expect(r.read).toBe(1);
    const doc = await fetchMsg(msg._id);
    expect(doc.status).toBe('read');
    expect(doc.deliveredAt).toBeTruthy();
    expect(doc.readAt).toBeTruthy();
  });
});

describe('markDelivered guard', () => {
  it('rejects non-members', async () => {
    if (!ready) return;
    const conv = await makeConv('group', [A, B, C]);
    await expect(chatService.markDelivered(u('outsider'), String(conv._id))).rejects.toMatchObject({ status: 403 });
  });
});

describe('markDeliveredEverywhere', () => {
  it('sweeps pending messages across all conversations, aggregated per roster', async () => {
    if (!ready) return;
    const D = u('d');
    const group = await makeConv('group', [A, B, D]);
    const direct = await makeConv('direct', [C, D]);
    const inGroup = await makeMsg(group._id, A);
    const inDirect = await makeMsg(direct._id, C);

    const res = await chatService.markDeliveredEverywhere(D);
    expect(res.conversations).toBe(2); // one emission per affected conversation
    expect(res.delivered).toBe(2);

    // Direct: D was the only recipient ⇒ 'delivered'. Group: any member having it counts too,
    // so D's sweep double-ticks the group message even though B is still pending.
    expect((await fetchMsg(inDirect._id)).status).toBe('delivered');
    const groupDoc = await fetchMsg(inGroup._id);
    expect(groupDoc.status).toBe('delivered');
    expect(groupDoc.deliveredTo).toContain(D);

    // Idempotent: nothing pending on a second sweep.
    const again = await chatService.markDeliveredEverywhere(D);
    expect(again).toEqual({ conversations: 0, delivered: 0 });
  });
});
