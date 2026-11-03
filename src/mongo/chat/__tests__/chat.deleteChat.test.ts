import { Types } from 'mongoose';
import { connectMongo, disconnectMongo } from '../../connection';
import { ConversationModel, MessageModel, type ConversationDoc, type MessageDoc } from '../chat.models';
import { conversationRepo, messageRepo } from '../chat.repository';
import { chatService } from '../chat.service';

// INTEGRATION: "Delete chat" on a one-to-one chat (owner, 2026-11-03). Gone from MY list with every
// message in it; the other person keeps theirs; a later message brings the chat back empty before it.
// Self-skips without Mongo; cleans up everything it creates.
let ready = false;
const run = `t${Date.now().toString(36)}`;
const u = (n: string): string => `test-delchat-${run}-${n}`;
const convIds: Types.ObjectId[] = [];

const member = (userId: string, role: 'admin' | 'member' = 'member') =>
  ({ userId, role, joinedAt: new Date(), lastReadAt: null, unread: 0, muted: false, mutedUntil: null, archived: false, pinned: false });

async function makeDirect(a: string, b: string): Promise<string> {
  const conv = await ConversationModel().create({
    type: 'direct', participantIds: [a, b], members: [member(a), member(b)],
    createdBy: a, lastActivityAt: new Date(), directKey: [a, b].sort().join('|'),
  });
  convIds.push(conv._id);
  return String(conv._id);
}
async function makeGroup(participantIds: string[]): Promise<string> {
  const conv = await ConversationModel().create({
    type: 'group', name: `delete chat test ${convIds.length}`, participantIds,
    members: participantIds.map((p, i) => member(p, i === 0 ? 'admin' : 'member')), createdBy: participantIds[0], lastActivityAt: new Date(),
  });
  convIds.push(conv._id);
  return String(conv._id);
}
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 15));
// A message as the send path leaves it: stored, then the conversation's preview + unread bumped.
async function say(cid: string, senderId: string, text: string): Promise<MessageDoc> {
  const m = (await messageRepo.create({ conversationId: new Types.ObjectId(cid), senderId, type: 'text', text, status: 'sent', sentAt: new Date(), deliveredTo: [senderId], readBy: [] })) as unknown as MessageDoc;
  await conversationRepo.touchLastMessage(cid, { messageId: m._id, text, type: 'text', senderId, at: m.createdAt }, senderId);
  return m;
}
const listIds = async (userId: string): Promise<string[]> => (await chatService.listConversations(userId)).map((c) => c.id);
const memberOf = async (cid: string, userId: string) => {
  const c = await ConversationModel().findById(cid).lean<ConversationDoc>();
  return c!.members.find((m) => m.userId === userId)!;
};

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

describe('delete chat — mine only', () => {
  it('takes the chat and its messages off my side and leaves the other person untouched', async () => {
    if (!ready) return;
    const [me, other] = [u('a1'), u('b1')];
    const cid = await makeDirect(me, other);
    await say(cid, other, 'hello');
    await say(cid, me, 'hi there');

    const r = await chatService.deleteChat(me, cid);
    expect(r.ok).toBe(true);

    expect(await listIds(me)).not.toContain(cid);
    expect(await chatService.getMessages(me, cid, {})).toEqual([]);
    // theirs: still listed, every message still there
    expect(await listIds(other)).toContain(cid);
    expect((await chatService.getMessages(other, cid, {})).map((m) => m.text)).toEqual(['hello', 'hi there']);
  });

  it('clears my unread, pin and archive, keeps my mute, and does not mark the messages read', async () => {
    if (!ready) return;
    const [me, other] = [u('a2'), u('b2')];
    const cid = await makeDirect(me, other);
    await chatService.setConversationSettings(me, cid, { muted: true, pinned: true, archived: true });
    await say(cid, other, 'unread one');
    expect((await memberOf(cid, me)).unread).toBe(1);

    await chatService.deleteChat(me, cid);

    const mine = await memberOf(cid, me);
    expect(mine).toMatchObject({ unread: 0, pinned: false, archived: false, muted: true });
    expect(mine.clearedAt).toBeTruthy();
    const msg = await MessageModel().findOne({ conversationId: new Types.ObjectId(cid) }).lean<MessageDoc>();
    expect(msg!.readBy).toEqual([]); // the other side's ticks stay as they were
  });

  it('brings the chat back on the next message, with only what came after', async () => {
    if (!ready) return;
    const [me, other] = [u('a3'), u('b3')];
    const cid = await makeDirect(me, other);
    await say(cid, other, 'old news');
    await chatService.deleteChat(me, cid);
    await tick();
    await say(cid, other, 'are you there?');

    const row = (await chatService.listConversations(me)).find((c) => c.id === cid);
    expect(row).toBeTruthy();
    expect(row!.lastMessage?.text).toBe('are you there?');
    expect((await chatService.getMessages(me, cid, {})).map((m) => m.text)).toEqual(['are you there?']);
  });

  it('opening the person again shows an empty chat, not the old preview', async () => {
    if (!ready) return;
    const [me, other] = [u('a4'), u('b4')];
    const cid = await makeDirect(me, other);
    await say(cid, other, 'secret preview');
    await chatService.deleteChat(me, cid);

    const dto = await chatService.conversationDTO((await conversationRepo.findById(cid))!, me);
    expect(dto.lastMessage).toBeNull();
    expect(dto.unread).toBe(0);
    expect(dto.clearedAt).toBeTruthy();
    // the other person's preview is untouched
    const theirs = await chatService.conversationDTO((await conversationRepo.findById(cid))!, other);
    expect(theirs.lastMessage?.text).toBe('secret preview');
    expect(theirs.clearedAt).toBeNull();
  });

  it('keeps deleted messages out of the catch-up sync, search, starred and pinned', async () => {
    if (!ready) return;
    const [me, other] = [u('a5'), u('b5')];
    const cid = await makeDirect(me, other);
    const since = new Date(Date.now() - 1000);
    const m = await say(cid, other, 'findable invoice 9911');
    await chatService.star(me, String(m._id));
    await chatService.pin(me, String(m._id));
    expect((await chatService.search(me, 'invoice 9911')).length).toBe(1);

    await chatService.deleteChat(me, cid);

    expect((await chatService.syncSince(me, since, undefined)).messages.filter((x) => x.conversationId === cid)).toEqual([]);
    expect(await chatService.search(me, 'invoice 9911')).toEqual([]);
    expect((await chatService.starred(me)).filter((x) => x.conversationId === cid)).toEqual([]);
    expect(await chatService.pinned(me, cid)).toEqual([]);
    // still pinned for the other person
    expect((await chatService.pinned(other, cid)).map((x) => x.text)).toEqual(['findable invoice 9911']);
  });
});

describe('delete chat — refused', () => {
  it('refuses a group (leave it, or an admin deletes it for everyone)', async () => {
    if (!ready) return;
    const [me, other] = [u('a6'), u('b6')];
    const gid = await makeGroup([me, other]);
    await expect(chatService.deleteChat(me, gid)).rejects.toMatchObject({ status: 400 });
    expect(await listIds(me)).toContain(gid);
  });

  it('refuses a chat the caller is not in', async () => {
    if (!ready) return;
    const cid = await makeDirect(u('a7'), u('b7'));
    await expect(chatService.deleteChat(u('stranger'), cid)).rejects.toMatchObject({ status: 403 });
  });

  it('404s an unknown chat', async () => {
    if (!ready) return;
    await expect(chatService.deleteChat(u('a8'), String(new Types.ObjectId()))).rejects.toMatchObject({ status: 404 });
  });
});
