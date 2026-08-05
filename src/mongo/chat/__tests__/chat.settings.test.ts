import { Types } from 'mongoose';
import { connectMongo, disconnectMongo } from '../../connection';
import { ChatSettingsModel, ConversationModel, MessageModel, StatusModel, type ConversationDoc } from '../chat.models';
import { chatService } from '../chat.service';
import { statusService } from '../chat.status';

// INTEGRATION: the per-chat and per-account settings — mute/archive/pin, blocking, privacy,
// disappearing messages and status. Self-skips without Mongo; cleans up everything it creates.
let ready = false;
const run = `t${Date.now().toString(36)}`;
const u = (n: string): string => `test-settings-${run}-${n}`;
const convIds: Types.ObjectId[] = [];
const users: string[] = [];

const member = (userId: string, role: 'admin' | 'member' = 'member') =>
  ({ userId, role, joinedAt: new Date(), lastReadAt: null, unread: 0, muted: false, mutedUntil: null, archived: false, pinned: false });

async function makeGroup(participantIds: string[], adminId?: string): Promise<string> {
  users.push(...participantIds);
  const conv = await ConversationModel().create({
    type: 'group', name: `settings test ${convIds.length}`, participantIds,
    members: participantIds.map((p) => member(p, p === adminId ? 'admin' : 'member')),
    createdBy: adminId ?? participantIds[0], lastActivityAt: new Date(),
  });
  convIds.push(conv._id);
  return String(conv._id);
}
async function makeDirect(a: string, b: string): Promise<string> {
  users.push(a, b);
  const conv = await ConversationModel().create({
    type: 'direct', participantIds: [a, b], members: [member(a), member(b)],
    createdBy: a, lastActivityAt: new Date(), directKey: [a, b].sort().join('|'),
  });
  convIds.push(conv._id);
  return String(conv._id);
}
const memberOf = async (cid: string, userId: string) => {
  const c = await ConversationModel().findById(cid).lean<ConversationDoc>();
  return c!.members.find((m) => m.userId === userId)!;
};

beforeAll(async () => {
  try { await connectMongo(); ready = true; } catch { ready = false; }
}, 30000);

afterAll(async () => {
  if (ready) {
    if (convIds.length) {
      await MessageModel().deleteMany({ conversationId: { $in: convIds } });
      await ConversationModel().deleteMany({ _id: { $in: convIds } });
    }
    if (users.length) {
      await ChatSettingsModel().deleteMany({ userId: { $in: users } });
      await StatusModel().deleteMany({ userId: { $in: users } });
    }
  }
  await disconnectMongo();
}, 20000);

describe('per-chat settings — personal, not shared', () => {
  it('mutes for the caller only, leaving everyone else untouched', async () => {
    if (!ready) return;
    const [me, other] = [u('mute-me'), u('mute-other')];
    const cid = await makeGroup([me, other]);

    await chatService.setConversationSettings(me, cid, { muted: true, muteHours: 8 });

    expect((await memberOf(cid, me)).muted).toBe(true);
    expect((await memberOf(cid, other)).muted).toBe(false); // muting a group is yours alone
  });

  it('stamps an expiry for a timed mute and clears it on unmute', async () => {
    if (!ready) return;
    const me = u('mute-timed');
    const cid = await makeGroup([me, u('mute-timed-b')]);

    await chatService.setConversationSettings(me, cid, { muted: true, muteHours: 8 });
    const timed = await memberOf(cid, me);
    expect(timed.mutedUntil).toBeTruthy();
    expect(timed.mutedUntil!.getTime()).toBeGreaterThan(Date.now() + 7 * 3600_000);

    await chatService.setConversationSettings(me, cid, { muted: false });
    expect((await memberOf(cid, me)).mutedUntil).toBeNull();
  });

  it('treats "Always" as muted with no expiry', async () => {
    if (!ready) return;
    const me = u('mute-always');
    const cid = await makeGroup([me, u('mute-always-b')]);

    await chatService.setConversationSettings(me, cid, { muted: true, muteHours: null });

    const m = await memberOf(cid, me);
    expect(m.muted).toBe(true);
    expect(m.mutedUntil).toBeNull();
  });

  it('reports a lapsed mute as OFF, so the client never has to know the rule', async () => {
    if (!ready) return;
    const me = u('mute-lapsed');
    const cid = await makeGroup([me, u('mute-lapsed-b')]);
    await chatService.setConversationSettings(me, cid, { muted: true, muteHours: 8 });
    // Wind the expiry back into the past.
    await ConversationModel().updateOne({ _id: new Types.ObjectId(cid), 'members.userId': me }, { $set: { 'members.$.mutedUntil': new Date(Date.now() - 1000) } });

    const conv = await ConversationModel().findById(cid).lean<ConversationDoc>();
    const dto = await chatService.conversationDTO(conv!, me) as { muted: boolean };
    expect(dto.muted).toBe(false);
  });

  it('archives and pins independently', async () => {
    if (!ready) return;
    const me = u('flags');
    const cid = await makeGroup([me, u('flags-b')]);

    await chatService.setConversationSettings(me, cid, { archived: true });
    await chatService.setConversationSettings(me, cid, { pinned: true });

    const m = await memberOf(cid, me);
    expect({ archived: m.archived, pinned: m.pinned }).toEqual({ archived: true, pinned: true });
  });

  it('refuses to change a chat the caller is not in', async () => {
    if (!ready) return;
    const cid = await makeGroup([u('closed-a'), u('closed-b')]);
    await expect(chatService.setConversationSettings(u('outsider'), cid, { muted: true })).rejects.toThrow();
  });
});

describe('blocking', () => {
  it('stops messages in both directions and never says which side blocked', async () => {
    if (!ready) return;
    const [a, b] = [u('block-a'), u('block-b')];
    const cid = await makeDirect(a, b);

    await chatService.setBlocked(a, b, true);

    await expect(chatService.sendMessage(a, cid, { text: 'hello' })).rejects.toThrow(/could not be sent/i);
    await expect(chatService.sendMessage(b, cid, { text: 'hello back' })).rejects.toThrow(/could not be sent/i);
  });

  it('lets messages flow again after unblocking', async () => {
    if (!ready) return;
    const [a, b] = [u('unblock-a'), u('unblock-b')];
    const cid = await makeDirect(a, b);
    await chatService.setBlocked(a, b, true);
    await chatService.setBlocked(a, b, false);

    await expect(chatService.sendMessage(a, cid, { text: 'back on' })).resolves.toBeTruthy();
  });

  it('does not touch group chats', async () => {
    if (!ready) return;
    const [a, b] = [u('gblock-a'), u('gblock-b')];
    const cid = await makeGroup([a, b, u('gblock-c')]);
    await chatService.setBlocked(a, b, true);

    await expect(chatService.sendMessage(a, cid, { text: 'group still works' })).resolves.toBeTruthy();
  });

  it('refuses self-blocking', async () => {
    if (!ready) return;
    const a = u('self');
    users.push(a);
    await expect(chatService.setBlocked(a, a, true)).rejects.toThrow();
  });
});

describe('privacy', () => {
  it('defaults to sharing, and persists a change', async () => {
    if (!ready) return;
    const me = u('privacy');
    users.push(me);

    expect(await chatService.getPrivacy(me)).toMatchObject({ readReceipts: true, lastSeen: 'everyone' });

    await chatService.updatePrivacy(me, { readReceipts: false, lastSeen: 'nobody' });
    expect(await chatService.getPrivacy(me)).toMatchObject({ readReceipts: false, lastSeen: 'nobody' });
  });
});

describe('disappearing messages', () => {
  it('stamps an expiry on messages sent AFTER it is switched on, never on history', async () => {
    if (!ready) return;
    const [a, b] = [u('disap-a'), u('disap-b')];
    const cid = await makeDirect(a, b);

    const before = await chatService.sendMessage(a, cid, { text: 'sent in the open' });
    await chatService.setDisappearing(a, cid, 86400);
    const after = await chatService.sendMessage(a, cid, { text: 'this one expires' });

    const beforeDoc = await MessageModel().findById(before.id).lean();
    const afterDoc = await MessageModel().findById(after.id).lean();
    expect(beforeDoc!.expiresAt).toBeNull();       // turning it on is never retroactive
    expect(afterDoc!.expiresAt).toBeTruthy();
  });

  it('stops stamping once switched off', async () => {
    if (!ready) return;
    const [a, b] = [u('disap-off-a'), u('disap-off-b')];
    const cid = await makeDirect(a, b);
    await chatService.setDisappearing(a, cid, 86400);
    await chatService.setDisappearing(a, cid, null);

    const m = await chatService.sendMessage(a, cid, { text: 'permanent again' });
    expect((await MessageModel().findById(m.id).lean())!.expiresAt).toBeNull();
  });

  it('rejects an absurd duration', async () => {
    if (!ready) return;
    const [a, b] = [u('disap-bad-a'), u('disap-bad-b')];
    const cid = await makeDirect(a, b);
    await expect(chatService.setDisappearing(a, cid, 5)).rejects.toThrow();
    await expect(chatService.setDisappearing(a, cid, 999 * 86400)).rejects.toThrow();
  });

  it('is admin-only in a group', async () => {
    if (!ready) return;
    const [admin, plain] = [u('disap-admin'), u('disap-plain')];
    const cid = await makeGroup([admin, plain], admin);

    await expect(chatService.setDisappearing(plain, cid, 86400)).rejects.toThrow();
    await expect(chatService.setDisappearing(admin, cid, 86400)).resolves.toMatchObject({ disappearAfterSec: 86400 });
  });
});

describe('status', () => {
  it('is visible to the people you share a conversation with, and to nobody else', async () => {
    if (!ready) return;
    const [me, peer, stranger] = [u('st-me'), u('st-peer'), u('st-stranger')];
    await makeDirect(me, peer);
    users.push(stranger);

    await statusService.post(me, { type: 'text', caption: 'On site in Nairobi today' });

    expect((await statusService.feed(peer)).some((e) => e.userId === me)).toBe(true);
    expect((await statusService.feed(stranger)).some((e) => e.userId === me)).toBe(false);
  });

  it('hides the viewer list from everyone but the poster', async () => {
    if (!ready) return;
    const [me, peer] = [u('st-v-me'), u('st-v-peer')];
    await makeDirect(me, peer);
    const posted = await statusService.post(me, { type: 'text', caption: 'hello' });

    await statusService.markViewed(peer, posted.id);

    const mine = (await statusService.feed(me)).find((e) => e.userId === me)!;
    expect(mine.items[0].viewCount).toBe(1);
    expect(mine.items[0].viewers.map((v) => v.userId)).toEqual([peer]);

    const theirs = (await statusService.feed(peer)).find((e) => e.userId === me)!;
    expect(theirs.items[0].viewCount).toBe(0);   // viewers are private to the author
    expect(theirs.items[0].viewers).toEqual([]);
    expect(theirs.items[0].viewed).toBe(true);   // but they know they have seen it
  });

  it('counts a view once, and never counts the poster viewing their own', async () => {
    if (!ready) return;
    const [me, peer] = [u('st-c-me'), u('st-c-peer')];
    await makeDirect(me, peer);
    const posted = await statusService.post(me, { type: 'text', caption: 'once' });

    await statusService.markViewed(peer, posted.id);
    await statusService.markViewed(peer, posted.id);
    await statusService.markViewed(me, posted.id);

    const mine = (await statusService.feed(me)).find((e) => e.userId === me)!;
    expect(mine.items[0].viewCount).toBe(1);
  });

  it('expires in 24 hours', async () => {
    if (!ready) return;
    const me = u('st-ttl');
    await makeDirect(me, u('st-ttl-peer'));
    const posted = await statusService.post(me, { type: 'text', caption: 'temporary' });

    const ttl = new Date(posted.expiresAt).getTime() - Date.now();
    expect(ttl).toBeGreaterThan(23 * 3600_000);
    expect(ttl).toBeLessThanOrEqual(24 * 3600_000);
  });

  it('will not post an empty text card, and only the author can delete', async () => {
    if (!ready) return;
    const [me, peer] = [u('st-guard-me'), u('st-guard-peer')];
    await makeDirect(me, peer);

    await expect(statusService.post(me, { type: 'text', caption: '   ' })).rejects.toThrow();
    const posted = await statusService.post(me, { type: 'text', caption: 'mine' });
    await expect(statusService.remove(peer, posted.id)).rejects.toThrow();
    await expect(statusService.remove(me, posted.id)).resolves.toMatchObject({ ok: true });
  });

  it('is not shown to someone you blocked', async () => {
    if (!ready) return;
    const [me, blocked] = [u('st-b-me'), u('st-b-them')];
    await makeDirect(me, blocked);
    await chatService.setBlocked(me, blocked, true);

    await statusService.post(me, { type: 'text', caption: 'not for you' });

    expect((await statusService.feed(blocked)).some((e) => e.userId === me)).toBe(false);
  });
});
