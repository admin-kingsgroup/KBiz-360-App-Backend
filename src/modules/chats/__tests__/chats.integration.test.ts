import request from 'supertest';
import { createApp } from '../../../app';
import { prisma } from '../../../db/prisma';

// Integration — reproduces chatUnread.test / chatList.test over the API (DM list NOT access-filtered;
// unread-first sort; markRead → 0). Requires a migrated, SEEDED DB; self-skips otherwise.
const app = createApp();
const SUPER = { identifier: 'afshin@kbiz360.com', password: 'kbiz360' }; // a1 = 'Afshin Dhanani' (DM u1 is self)
const ROHAN = { identifier: 'rohan@travkings.com', password: 'kbiz360' }; // a6 — no DM entry, no participants

let dbReady = false;
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const tok = async (c: { identifier: string; password: string }) =>
  (await request(app).post('/api/auth/login').send(c)).body.accessToken as string;

beforeAll(async () => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    const a = await prisma.user.findFirst({ where: { email: SUPER.identifier } });
    dbReady = Boolean(a?.passwordHash);
  } catch {
    /* skip */
  }
  if (!dbReady) return;
  // Reset chat state to seed values so the suite is re-runnable.
  await prisma.message.deleteMany({ where: { chatId: 'u3' } });
  await prisma.chatParticipant.updateMany({ where: { userId: 'a1' }, data: { unread: 0 } });
  await prisma.chatParticipant.update({ where: { chatId_userId: { chatId: 'u1', userId: 'a1' } }, data: { unread: 2 } });
  await prisma.chatParticipant.update({ where: { chatId_userId: { chatId: 'u3', userId: 'a1' } }, data: { unread: 1 } });
});

afterAll(async () => {
  if (dbReady) await prisma.message.deleteMany({ where: { chatId: 'u3' } });
  await prisma.$disconnect();
});

describe('Chat — DM list + unread (over the API)', () => {
  it('GET /chats (Super): self-excluded (u1), unread-first, unreadTotal from seed', async () => {
    if (!dbReady) return;
    const res = await request(app).get('/api/chats').set(auth(await tok(SUPER)));
    expect(res.status).toBe(200);
    expect(res.body.chats.length).toBe(6); // 7 DMs − self (u1)
    expect(res.body.chats.some((c: { id: string }) => c.id === 'u1')).toBe(false);
    expect(res.body.chats[0].id).toBe('u3'); // only unread among the 6 → first
    expect(res.body.unreadTotal).toBe(3); // u1:2 + u3:1
  });

  it('DM list is NOT access-filtered: Employee sees all 7, unreadTotal 0', async () => {
    if (!dbReady) return;
    const res = await request(app).get('/api/chats').set(auth(await tok(ROHAN)));
    expect(res.body.chats.length).toBe(7); // no self-exclusion, no access filter
    expect(res.body.unreadTotal).toBe(0); // no participant rows for Rohan
  });

  it('POST /chats/:id/read clears unread (markRead → 0)', async () => {
    if (!dbReady) return;
    const t = await tok(SUPER);
    expect((await request(app).post('/api/chats/u3/read').set(auth(t))).status).toBe(204);
    const res = await request(app).get('/api/chats').set(auth(t));
    expect(res.body.unreadTotal).toBe(2); // u1:2 remains
    const u3 = res.body.chats.find((c: { id: string }) => c.id === 'u3');
    expect(u3.unread).toBe(0);
  });

  it('POST /messages then GET messages returns it', async () => {
    if (!dbReady) return;
    const t = await tok(SUPER);
    const sent = await request(app).post('/api/messages').set(auth(t)).send({ chatId: 'u3', body: 'hello there' });
    expect(sent.status).toBe(201);
    expect(sent.body.senderId).toBe('a1');
    const msgs = await request(app).get('/api/chats/u3/messages').set(auth(t));
    expect(msgs.body.length).toBe(1);
    expect(msgs.body[0].body).toBe('hello there');
  });

  it('GET /chats without auth → 401', async () => {
    if (!dbReady) return;
    expect((await request(app).get('/api/chats')).status).toBe(401);
  });
});
