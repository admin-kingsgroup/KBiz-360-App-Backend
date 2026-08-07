import { Types } from 'mongoose';
import { connectMongo, disconnectMongo } from '../../connection';
import { ConversationModel, MessageModel, type MessageDoc } from '../chat.models';
import { messageRepo } from '../chat.repository';
import { chatService } from '../chat.service';

// INTEGRATION: the message-search surface behind the in-chat search bar (scoped to one conversation)
// and the global search screen (all my conversations). Self-skips without Mongo; cleans up after.
let ready = false;
const run = `t${Date.now().toString(36)}`;
const u = (n: string): string => `test-search-${run}-${n}`;
const A = u('a');
const B = u('b');
const convIds: Types.ObjectId[] = [];

const member = (userId: string) => ({ userId, role: 'member' as const, joinedAt: new Date(), lastReadAt: null, unread: 0, muted: false, archived: false });
async function makeConv(participantIds: string[]): Promise<Types.ObjectId> {
  const conv = await ConversationModel().create({
    type: 'group', name: `search test ${convIds.length}`, participantIds,
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

describe('search — substring semantics', () => {
  it('matches partial words case-insensitively (what a chat search box means by "search")', async () => {
    if (!ready) return;
    const cid = await makeConv([A, B]);
    await makeMsg(cid, B, 'The Invoice #4411 was rejected');
    await makeMsg(cid, B, 'unrelated');

    const hits = await chatService.search(A, 'invo', { conversationId: String(cid) });
    expect(hits.map((m) => m.text)).toEqual(['The Invoice #4411 was rejected']);
  });

  it('treats regex metacharacters as literal text', async () => {
    if (!ready) return;
    const cid = await makeConv([A, B]);
    await makeMsg(cid, B, 'pay $500 (urgent)');
    await makeMsg(cid, B, 'pay 500 urgent');

    const hits = await chatService.search(A, '$500 (urgent)', { conversationId: String(cid) });
    expect(hits.map((m) => m.text)).toEqual(['pay $500 (urgent)']);
  });
});

describe('search — scope and visibility', () => {
  it('scopes to one conversation when conversationId is given', async () => {
    if (!ready) return;
    const here = await makeConv([A, B]);
    const elsewhere = await makeConv([A, B]);
    await makeMsg(here, B, 'quarterly target here');
    await makeMsg(elsewhere, B, 'quarterly target elsewhere');

    const hits = await chatService.search(A, 'quarterly target', { conversationId: String(here) });
    expect(hits.map((m) => m.text)).toEqual(['quarterly target here']);
  });

  it('refuses a conversation the caller is not in', async () => {
    if (!ready) return;
    const theirs = await makeConv([B, u('third')]);
    await makeMsg(theirs, B, 'private note');

    await expect(chatService.search(A, 'private', { conversationId: String(theirs) })).rejects.toMatchObject({ status: 403 });
  });

  it('global search spans my conversations but never someone else\'s', async () => {
    if (!ready) return;
    const me = u('global');
    const mine = await makeConv([me, B]);
    const others = await makeConv([B, u('outsider')]);
    await makeMsg(mine, B, 'zebra-keyword visible');
    await makeMsg(others, B, 'zebra-keyword hidden');

    const hits = await chatService.search(me, 'zebra-keyword');
    expect(hits.map((m) => m.text)).toEqual(['zebra-keyword visible']);
  });

  it('hides deleted-for-me and deleted-for-everyone messages', async () => {
    if (!ready) return;
    const cid = await makeConv([A, B]);
    await makeMsg(cid, B, 'needle kept');
    const forMe = await makeMsg(cid, B, 'needle deleted for me');
    const forAll = await makeMsg(cid, B, 'needle deleted for everyone');
    await MessageModel().updateOne({ _id: forMe._id }, { $addToSet: { deletedFor: A } });
    await MessageModel().updateOne({ _id: forAll._id }, { $set: { deletedForEveryone: true } });

    const hits = await chatService.search(A, 'needle', { conversationId: String(cid) });
    expect(hits.map((m) => m.text)).toEqual(['needle kept']);
  });
});

describe('search — ordering and paging', () => {
  it('returns newest-first and pages older results with `before`', async () => {
    if (!ready) return;
    const cid = await makeConv([A, B]);
    const seq: MessageDoc[] = [];
    for (const t of ['paging one', 'paging two', 'paging three']) seq.push(await makeMsg(cid, B, t));

    const first = await chatService.search(A, 'paging', { conversationId: String(cid) });
    expect(first.map((m) => m.text)).toEqual(['paging three', 'paging two', 'paging one']);

    const older = await chatService.search(A, 'paging', { conversationId: String(cid), before: first[1].id });
    expect(older.map((m) => m.text)).toEqual(['paging one']);
  });

  it('returns nothing for a blank query', async () => {
    if (!ready) return;
    expect(await chatService.search(A, '   ')).toEqual([]);
  });
});
