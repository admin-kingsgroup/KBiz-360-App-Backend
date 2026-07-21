import { Types } from 'mongoose';
import { connectMongo, disconnectMongo } from '../../connection';
import { ConversationModel, MessageModel } from '../chat.models';
import { crmRepo } from '../../crm.repo';
import { chatService } from '../chat.service';

// The add-only allowlist: faiz/pravesh/farhan@travkings.com may ADD members to a group they belong
// to (without being admin/creator), but still cannot remove members. Uses faiz's REAL id (the guard
// resolves the email from the CRM); the group creator + the person-to-add are synthetic. Self-skips
// when Mongo/the user isn't reachable; cleans up after.
let ready = false;
let faizId = '';
const run = `t${Date.now().toString(36)}`;
const CREATOR = `gtest-${run}-creator`;
const OUTSIDER = `gtest-${run}-outsider`; // a non-allowlisted plain member
const NEWBIE = `gtest-${run}-newbie`;
const convIds: Types.ObjectId[] = [];

const member = (userId: string, role: 'admin' | 'member' = 'member') => ({ userId, role, joinedAt: new Date(), lastReadAt: null, unread: 0, muted: false, archived: false });

beforeAll(async () => {
  try {
    await connectMongo();
    const faiz = await crmRepo.findUserByEmail('faiz@travkings.com');
    ready = !!faiz;
    if (faiz) faizId = String(faiz._id);
  } catch {
    ready = false;
  }
}, 40000);

afterAll(async () => {
  if (ready && convIds.length) {
    await ConversationModel().deleteMany({ _id: { $in: convIds } });
    await MessageModel().deleteMany({ conversationId: { $in: convIds } });
  }
  await disconnectMongo();
}, 20000);

async function makeGroup(): Promise<string> {
  // Creator is CREATOR (synthetic). faiz + OUTSIDER are plain members. So faiz is NOT admin/creator.
  const conv = await ConversationModel().create({
    type: 'group',
    name: 'add-members test',
    participantIds: [CREATOR, faizId, OUTSIDER],
    members: [member(CREATOR, 'admin'), member(faizId), member(OUTSIDER)],
    createdBy: CREATOR,
    lastActivityAt: new Date(),
  });
  convIds.push(conv._id);
  return String(conv._id);
}

describe('group add-members allowlist (add-only)', () => {
  it('an allowlisted member (faiz) who is NOT admin can add people', async () => {
    if (!ready) return;
    const gid = await makeGroup();
    const dto = await chatService.addMembers(faizId, gid, [NEWBIE]);
    expect(dto.memberCount).toBeGreaterThanOrEqual(4);
    const conv = await ConversationModel().findById(gid).lean();
    expect(conv?.participantIds).toContain(NEWBIE);
  }, 30000);

  it('a non-allowlisted plain member cannot add people', async () => {
    if (!ready) return;
    const gid = await makeGroup();
    await expect(chatService.addMembers(OUTSIDER, gid, [NEWBIE])).rejects.toThrow(/group admin/i);
  }, 30000);

  it('the allowlist is ADD-only — faiz still cannot remove another member', async () => {
    if (!ready) return;
    const gid = await makeGroup();
    await expect(chatService.removeMember(faizId, gid, OUTSIDER)).rejects.toThrow(/group admin/i);
  }, 30000);
});
