import { Types } from 'mongoose';
import { connectMongo, disconnectMongo } from '../../connection';
import { ConversationModel, MessageModel } from '../chat.models';
import { messageRepo } from '../chat.repository';
import { chatService } from '../chat.service';

// INTEGRATION: which task chats someone has written in — the app's task chat badge turns from red to
// green on it (owner, 2026-11-17). The app's own notices ("X started a chat about this task", status
// changes) do not count. Self-skips without Mongo; cleans up after.
let ready = false;
const run = `t${Date.now().toString(36)}`;
const u = (n: string): string => `test-people-${run}-${n}`;
const A = u('a');
const B = u('b');
const convIds: Types.ObjectId[] = [];

const member = (userId: string) => ({ userId, role: 'member' as const, joinedAt: new Date(), lastReadAt: null, unread: 0, muted: false, archived: false });
async function makeConv(): Promise<Types.ObjectId> {
  const conv = await ConversationModel().create({
    type: 'group', name: `people test ${convIds.length}`, participantIds: [A, B],
    members: [A, B].map(member), createdBy: A, lastActivityAt: new Date(),
  });
  convIds.push(conv._id);
  return conv._id;
}
const say = (conversationId: Types.ObjectId, type: 'text' | 'system', text: string) =>
  messageRepo.create({ conversationId, senderId: type === 'system' ? 'system' : A, type, text, status: 'sent', sentAt: new Date(), deliveredTo: [A], readBy: [] });

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

describe('withPeopleMessages', () => {
  it('counts a chat once a person writes, not for the app\'s notices alone', async () => {
    if (!ready) return;
    const noticesOnly = await makeConv();
    await say(noticesOnly, 'system', 'Satish started a chat about this task');
    await say(noticesOnly, 'system', 'Status: In progress');
    const talked = await makeConv();
    await say(talked, 'system', 'Afshin started a chat about this task');
    await say(talked, 'text', 'On it');
    const empty = await makeConv();

    const got = await chatService.withPeopleMessages([String(noticesOnly), String(talked), String(empty)]);
    expect([...got]).toEqual([String(talked)]);
  });

  it('ignores ids that are not chats, and a chat asked about twice', async () => {
    if (!ready) return;
    const talked = await makeConv();
    await say(talked, 'text', 'Hello');
    const got = await chatService.withPeopleMessages(['not-an-id', String(talked), String(talked)]);
    expect([...got]).toEqual([String(talked)]);
  });

  it('asks nothing for no chats', async () => {
    if (!ready) return;
    expect((await chatService.withPeopleMessages([])).size).toBe(0);
  });
});
