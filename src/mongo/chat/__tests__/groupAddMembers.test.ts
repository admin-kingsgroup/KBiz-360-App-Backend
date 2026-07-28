import { Types } from 'mongoose';
import { connectMongo, disconnectMongo } from '../../connection';
import { ConversationModel, MessageModel } from '../chat.models';
import { crmRepo } from '../../crm.repo';
import { chatService } from '../chat.service';

// Allowlists: faiz/pravesh/farhan@travkings.com may ADD members to a group they belong to (without
// being admin/creator); faiz is additionally on the EDIT allowlist (rename + remove members) and
// farhan on the RENAME-only allowlist — but deleting the group / promoting admins stays admin-only
// for everyone. Uses faiz's + farhan's REAL ids (the guards resolve the email from the CRM); the
// group creator + the person-to-add are synthetic. Self-skips when Mongo/the users aren't
// reachable; cleans up after.
let ready = false;
let faizId = '';
let farhanId = '';
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
    const farhan = await crmRepo.findUserByEmail('farhan@travkings.com');
    ready = !!faiz && !!farhan;
    if (faiz) faizId = String(faiz._id);
    if (farhan) farhanId = String(farhan._id);
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
  // Creator is CREATOR (synthetic). faiz + farhan + OUTSIDER are plain members — NOT admin/creator.
  const conv = await ConversationModel().create({
    type: 'group',
    name: 'add-members test',
    participantIds: [CREATOR, faizId, farhanId, OUTSIDER],
    members: [member(CREATOR, 'admin'), member(faizId), member(farhanId), member(OUTSIDER)],
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

  it('an edit-allowlisted member (faiz) who is NOT admin can remove another member', async () => {
    if (!ready) return;
    const gid = await makeGroup();
    await chatService.removeMember(faizId, gid, OUTSIDER);
    const conv = await ConversationModel().findById(gid).lean();
    expect(conv?.participantIds).not.toContain(OUTSIDER);
  }, 30000);

  it('an edit-allowlisted member (faiz) who is NOT admin can rename the group', async () => {
    if (!ready) return;
    const gid = await makeGroup();
    const dto = await chatService.updateGroup(faizId, gid, { name: 'renamed by faiz' });
    expect(dto.name).toBe('renamed by faiz');
  }, 30000);

  it('a non-allowlisted plain member can neither rename nor remove', async () => {
    if (!ready) return;
    const gid = await makeGroup();
    await expect(chatService.updateGroup(OUTSIDER, gid, { name: 'nope' })).rejects.toThrow(/group admin/i);
    await expect(chatService.removeMember(OUTSIDER, gid, faizId)).rejects.toThrow(/group admin/i);
  }, 30000);

  it('a rename-allowlisted member (farhan) who is NOT admin can rename but NOT remove', async () => {
    if (!ready) return;
    const gid = await makeGroup();
    const dto = await chatService.updateGroup(farhanId, gid, { name: 'renamed by farhan' });
    expect(dto.name).toBe('renamed by farhan');
    await expect(chatService.removeMember(farhanId, gid, OUTSIDER)).rejects.toThrow(/group admin/i);
  }, 30000);

  it('the edit allowlist does NOT extend to deleting the group or promoting admins', async () => {
    if (!ready) return;
    const gid = await makeGroup();
    await expect(chatService.deleteGroup(faizId, gid)).rejects.toThrow(/group admin/i);
    await expect(chatService.promoteAdmin(faizId, gid, OUTSIDER)).rejects.toThrow(/group admin/i);
  }, 30000);
});
