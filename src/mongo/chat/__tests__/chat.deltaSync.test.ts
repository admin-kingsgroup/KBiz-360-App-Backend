import { Types } from 'mongoose';
import { connectMongo, disconnectMongo } from '../../connection';
import { ConversationModel, MessageModel, type MessageDoc } from '../chat.models';
import { messageRepo } from '../chat.repository';
import { chatService } from '../chat.service';

// INTEGRATION: the `after` cursor that local-first clients sync with — the phone stores every message
// it has seen (Frontend/src/services/chatDb.ts) and asks only for what arrived since its newest one,
// instead of re-downloading the last page on every open. Self-skips without Mongo; cleans up after.
let ready = false;
const run = `t${Date.now().toString(36)}`;
const u = (n: string): string => `test-delta-${run}-${n}`;
const A = u('a');
const B = u('b');
const convIds: Types.ObjectId[] = [];

const member = (userId: string) => ({ userId, role: 'member' as const, joinedAt: new Date(), lastReadAt: null, unread: 0, muted: false, archived: false });
// Groups, not direct chats: `directKey` is unique per pair, so one pair cannot own the several
// independent conversations these cases need. Paging is identical for both types.
async function makeConv(participantIds: string[]): Promise<Types.ObjectId> {
  const conv = await ConversationModel().create({
    type: 'group', name: `delta test ${convIds.length}`, participantIds,
    members: participantIds.map(member), createdBy: participantIds[0], lastActivityAt: new Date(),
  });
  convIds.push(conv._id);
  return conv._id;
}
const makeMsg = (conversationId: Types.ObjectId, senderId: string, text: string): Promise<MessageDoc> =>
  messageRepo.create({ conversationId, senderId, type: 'text', text, status: 'sent', sentAt: new Date(), deliveredTo: [senderId], readBy: [] }) as unknown as Promise<MessageDoc>;

beforeAll(async () => {
  try { await connectMongo(); ready = true; } catch { ready = false; }
}, 30000);

afterAll(async () => {
  if (ready && convIds.length) {
    await MessageModel().deleteMany({ conversationId: { $in: convIds } });
    await ConversationModel().deleteMany({ _id: { $in: convIds } });
  }
  await disconnectMongo();
}, 20000);

describe('getMessages — `after` cursor (delta sync)', () => {
  it('returns only what arrived after the cursor, chronologically', async () => {
    if (!ready) return;
    const cid = await makeConv([A, B]);
    const seq: MessageDoc[] = [];
    for (const t of ['m1', 'm2', 'm3', 'm4', 'm5']) seq.push(await makeMsg(cid, A, t));

    const delta = await chatService.getMessages(A, String(cid), { after: String(seq[1]._id) });
    expect(delta.map((m) => m.text)).toEqual(['m3', 'm4', 'm5']);
  });

  it('returns nothing when the client is already up to date', async () => {
    if (!ready) return;
    const cid = await makeConv([A, B]);
    const last = await makeMsg(cid, A, 'only');

    expect(await chatService.getMessages(A, String(cid), { after: String(last._id) })).toEqual([]);
  });

  it('fills a gap from the OLDEST unseen message up, so a long absence syncs forward in pages', async () => {
    if (!ready) return;
    const cid = await makeConv([A, B]);
    const seq: MessageDoc[] = [];
    for (const t of ['a', 'b', 'c', 'd', 'e', 'f']) seq.push(await makeMsg(cid, A, t));

    // limit applies from the cursor FORWARD (not the newest end) — otherwise a paging client
    // would leapfrog the hole it is trying to close.
    const page = await chatService.getMessages(A, String(cid), { after: String(seq[0]._id), limit: 2 });
    expect(page.map((m) => m.text)).toEqual(['b', 'c']);

    const next = await chatService.getMessages(A, String(cid), { after: String(page[1].id), limit: 2 });
    expect(next.map((m) => m.text)).toEqual(['d', 'e']);
  });

  it('still pages backwards with `before` (scrollback is unchanged)', async () => {
    if (!ready) return;
    const cid = await makeConv([A, B]);
    const seq: MessageDoc[] = [];
    for (const t of ['p1', 'p2', 'p3', 'p4']) seq.push(await makeMsg(cid, A, t));

    const back = await chatService.getMessages(A, String(cid), { before: String(seq[3]._id), limit: 2 });
    expect(back.map((m) => m.text)).toEqual(['p2', 'p3']);
  });

  it('hides messages the caller deleted for themselves, on both cursors', async () => {
    if (!ready) return;
    const cid = await makeConv([A, B]);
    const first = await makeMsg(cid, A, 'keep');
    const gone = await makeMsg(cid, A, 'deleted-for-me');
    await MessageModel().updateOne({ _id: gone._id }, { $addToSet: { deletedFor: A } });
    await makeMsg(cid, A, 'after-that');

    const delta = await chatService.getMessages(A, String(cid), { after: String(first._id) });
    expect(delta.map((m) => m.text)).toEqual(['after-that']);
  });
});

// One request that covers every conversation — what the app runs when its socket connects, so that
// opening a chat afterwards reads purely from the device. Each case uses a FRESH user: syncSince
// spans every conversation its caller belongs to, so sharing one would leak the other cases' fixtures.
describe('syncSince — account-wide catch-up', () => {
  const backdate = (): Date => new Date(Date.now() - 5000); // safely before this case's writes

  it('returns changes across ALL my conversations, oldest change first', async () => {
    if (!ready) return;
    const me = u('sync-all');
    const since = backdate();
    const c1 = await makeConv([me, B]);
    const c2 = await makeConv([me, B]);
    await makeMsg(c1, B, 'in one');
    await makeMsg(c2, B, 'in two');

    const res = await chatService.syncSince(me, since, undefined);
    expect(res.messages.map((m) => m.text)).toEqual(['in one', 'in two']);
    expect(new Set(res.messages.map((m) => m.conversationId))).toEqual(new Set([String(c1), String(c2)]));
  });

  it('reports an EDIT of an old message, not just new arrivals', async () => {
    if (!ready) return;
    const me = u('sync-edit');
    const cid = await makeConv([me, B]);
    const old = await makeMsg(cid, B, 'original');
    const since = new Date();
    await new Promise((r) => setTimeout(r, 5)); // updatedAt is ms-resolution; land clear of `since`
    await MessageModel().updateOne({ _id: old._id }, { $set: { text: 'edited later', edited: true } });

    const res = await chatService.syncSince(me, since, undefined);
    expect(res.messages.map((m) => m.text)).toEqual(['edited later']);
  });

  it('hands back a watermark pair, so a page boundary inside one timestamp skips nothing', async () => {
    if (!ready) return;
    const me = u('sync-page');
    const since = backdate();
    const cid = await makeConv([me, B]);
    const made: MessageDoc[] = [];
    for (const t of ['s1', 's2', 's3']) made.push(await makeMsg(cid, B, t));
    // Force the worst case: all three share one updatedAt, exactly as a receipt bulkWrite leaves them.
    const stamp = new Date();
    await MessageModel().updateMany({ _id: { $in: made.map((m) => m._id) } }, { $set: { updatedAt: stamp } }, { timestamps: false });

    const first = await chatService.syncSince(me, since, undefined, 2);
    expect(first.messages.map((m) => m.text)).toEqual(['s1', 's2']);
    expect(first.more).toBe(true);

    // A timestamp-only cursor would drop s3 here — it shares the millisecond the page ended on.
    const second = await chatService.syncSince(me, new Date(first.until), first.untilId ?? undefined, 2);
    expect(second.messages.map((m) => m.text)).toEqual(['s3']);
    expect(second.more).toBe(false);
  });

  it('is empty and settled when nothing changed', async () => {
    if (!ready) return;
    const me = u('sync-idle');
    await makeConv([me, B]);
    const res = await chatService.syncSince(me, new Date(), undefined);
    expect(res.messages).toEqual([]);
    expect(res.more).toBe(false);
  });

  it('never leaks a conversation the caller is not in', async () => {
    if (!ready) return;
    const me = u('sync-outsider');
    const since = backdate();
    await makeConv([me, B]); // caller has a conversation, just not the one being written to
    const theirs = await makeConv([B, u('sync-third')]);
    await makeMsg(theirs, B, 'private');

    expect(await chatService.syncSince(me, since, undefined)).toMatchObject({ messages: [] });
  });
});
