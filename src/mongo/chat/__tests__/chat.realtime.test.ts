import { createServer, type Server } from 'http';
import { type AddressInfo } from 'net';
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';
import request from 'supertest';
import { createMongoApp } from '../../app';
import { connectMongo, disconnectMongo } from '../../connection';
import { initRealtime } from '../../../realtime/socket';
import { registerChatHandlers } from '../chat.socket';
import { crmRepo } from '../../crm.repo';
import { signAccess } from '../../../modules/auth/jwt';
import { ConversationModel, MessageModel } from '../chat.models';
import { Types } from 'mongoose';

// END-TO-END: two authenticated users exchange messages in real time (1:1 + group).
// Writes only to kb360_app (conversations/messages); cleans up after. Self-skips without Mongo.
const app = createMongoApp();
let server: Server;
let port = 0;
let ready = false;
let idA = '';
let idB = '';
let tokenA = '';
let tokenB = '';
let sockA: ClientSocket | null = null;
let sockB: ClientSocket | null = null;
let directId = '';
let groupId = '';
const createdConvIds: string[] = [];

// Extended receipt payload (chat:delivered / chat:read): at is epoch ms, statuses is the
// authoritative aggregate status of every affected message.
interface ReceiptEvt { conversationId: string; by: string; messageIds: string[]; at: number; statuses: { id: string; status: string }[] }

const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
function waitFor<T = unknown>(sock: ClientSocket, event: string, ms = 5000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), ms);
    sock.once(event, (data: T) => { clearTimeout(timer); resolve(data); });
  });
}
// Like waitFor, but skips non-matching emissions (e.g. delivered-on-connect sweeps of OTHER conversations).
function waitForMatch<T = unknown>(sock: ClientSocket, event: string, pred: (e: T) => boolean, ms = 5000): Promise<T> {
  return new Promise((resolve, reject) => {
    const handler = (data: T): void => {
      if (!pred(data)) return;
      clearTimeout(timer);
      sock.off(event, handler);
      resolve(data);
    };
    const timer = setTimeout(() => { sock.off(event, handler); reject(new Error(`timeout waiting for ${event}`)); }, ms);
    sock.on(event, handler);
  });
}
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  try {
    await connectMongo();
    const a = await crmRepo.findUserByEmail('afshin.dhanani@kingsgroupco.com');
    const b = await crmRepo.findUserByEmail('pravesh@travkings.com');
    ready = Boolean(a && b);
    if (!ready) return;
    idA = String(a!._id); idB = String(b!._id);
    tokenA = signAccess(idA, 'super_admin');
    tokenB = signAccess(idB, 'branch_manager');

    server = createServer(app);
    registerChatHandlers(initRealtime(server));
    await new Promise<void>((res) => server.listen(0, res));
    port = (server.address() as AddressInfo).port;

    // Create the 1:1 conversation via REST.
    const conv = await request(app).post('/api/conversations').set(auth(tokenA)).send({ otherUserId: idB });
    directId = conv.body.id;
    createdConvIds.push(directId);

    // Connect both clients and join the conversation room.
    sockA = ioClient(`http://localhost:${port}`, { auth: { token: tokenA }, transports: ['websocket'] });
    sockB = ioClient(`http://localhost:${port}`, { auth: { token: tokenB }, transports: ['websocket'] });
    await Promise.all([waitFor(sockA, 'connect'), waitFor(sockB, 'connect')]);
    sockA.emit('chat:join', { conversationId: directId });
    sockB.emit('chat:join', { conversationId: directId });
    await delay(200);
  } catch {
    ready = false;
  }
}, 40000);

afterAll(async () => {
  sockA?.close();
  sockB?.close();
  if (server) await new Promise<void>((res) => server.close(() => res()));
  if (ready && createdConvIds.length) {
    const ids = createdConvIds.map((id) => new Types.ObjectId(id));
    await MessageModel().deleteMany({ conversationId: { $in: ids } });
    await ConversationModel().deleteMany({ _id: { $in: ids } });
  }
  await disconnectMongo();
}, 20000);

describe('Chat realtime — 1:1', () => {
  let messageId = '';

  it('A → B: message arrives in real time', async () => {
    if (!ready) return;
    const received = waitFor<{ id: string; text: string; senderId: string; conversationId: string }>(sockB!, 'chat:receive');
    const res = await request(app).post('/api/messages').set(auth(tokenA)).send({ conversationId: directId, text: 'hello B' });
    expect(res.status).toBe(201);
    const evt = await received;
    expect(evt.text).toBe('hello B');
    expect(evt.senderId).toBe(idA);
    expect(evt.conversationId).toBe(directId);
    messageId = res.body.id;
  });

  it('B acks delivery → A gets chat:delivered with statuses + epoch-ms at', async () => {
    if (!ready) return;
    const delivered = waitForMatch<ReceiptEvt>(sockA!, 'chat:delivered', (e) => e.conversationId === directId);
    sockB!.emit('chat:delivered', { conversationId: directId });
    const evt = await delivered;
    expect(evt.by).toBe(idB);
    expect(evt.messageIds).toContain(messageId);
    expect(typeof evt.at).toBe('number'); // epoch ms, never a Date/ISO string
    expect(evt.statuses.find((s) => s.id === messageId)?.status).toBe('delivered'); // direct: single recipient ⇒ aggregate delivered
  });

  it('B reads → A gets chat:read with statuses + epoch-ms at', async () => {
    if (!ready) return;
    const read = waitForMatch<ReceiptEvt>(sockA!, 'chat:read', (e) => e.conversationId === directId);
    sockB!.emit('chat:read', { conversationId: directId });
    const evt = await read;
    expect(evt.by).toBe(idB);
    expect(evt.conversationId).toBe(directId);
    expect(evt.messageIds).toContain(messageId);
    expect(typeof evt.at).toBe('number');
    expect(evt.statuses.find((s) => s.id === messageId)?.status).toBe('read'); // direct: single recipient read ⇒ aggregate read
  });

  it('B reacts → A gets chat:reaction', async () => {
    if (!ready) return;
    const reaction = waitFor<{ id: string; reactions: { userId: string; emoji: string }[] }>(sockA!, 'chat:reaction');
    const res = await request(app).post(`/api/messages/${messageId}/reaction`).set(auth(tokenB)).send({ emoji: '❤️' });
    expect(res.status).toBe(200);
    const evt = await reaction;
    expect(evt.reactions.some((r) => r.userId === idB && r.emoji === '❤️')).toBe(true);
  });

  it('B typing → A gets chat:typing', async () => {
    if (!ready) return;
    const typing = waitFor<{ conversationId: string; userId: string }>(sockA!, 'chat:typing');
    sockB!.emit('chat:typing', { conversationId: directId });
    const evt = await typing;
    expect(evt.userId).toBe(idB);
  });

  it('A edits → B gets chat:edit', async () => {
    if (!ready) return;
    const edited = waitFor<{ id: string; text: string }>(sockB!, 'chat:edit');
    const res = await request(app).put(`/api/messages/${messageId}`).set(auth(tokenA)).send({ text: 'hello B (edited)' });
    expect(res.status).toBe(200);
    expect((await edited).text).toBe('hello B (edited)');
  });

  it('GET /conversations lists the direct conversation with lastMessage ticks + ms lastSeen', async () => {
    if (!ready) return;
    const listA = await request(app).get('/api/conversations').set(auth(tokenA));
    const listB = await request(app).get('/api/conversations').set(auth(tokenB));
    expect(listB.body.some((c: { id: string }) => c.id === directId)).toBe(true);
    const row = listA.body.find((c: { id: string }) => c.id === directId) as { lastMessage: { id: string | null; status: string | null }; lastSeen: number | null };
    expect(row).toBeTruthy();
    expect(row.lastMessage.id).toBe(messageId); // additive: id + aggregate status for the chat-list tick
    expect(row.lastMessage.status).toBe('read');
    expect(row.lastSeen === null || typeof row.lastSeen === 'number').toBe(true); // epoch ms, never an ISO string
  });
});

describe('Chat realtime — presence + delivered-on-connect sweep', () => {
  it('B disconnects → chat:offline carries epoch-ms lastSeen; reconnect sweeps pending to delivered', async () => {
    if (!ready) return;
    const offline = waitForMatch<{ userId: string; lastSeen: number | null }>(sockA!, 'chat:offline', (e) => e.userId === idB);
    sockB!.close();
    const off = await offline;
    expect(typeof off.lastSeen).toBe('number'); // epoch ms, never a Date/ISO string

    // A messages B while B is offline → stays single-tick 'sent'.
    const res = await request(app).post('/api/messages').set(auth(tokenA)).send({ conversationId: directId, text: 'while you were away' });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('sent');

    // B reconnects → markDeliveredEverywhere double-ticks it WITHOUT B opening the chat.
    const delivered = waitForMatch<ReceiptEvt>(sockA!, 'chat:delivered', (e) => e.conversationId === directId);
    sockB = ioClient(`http://localhost:${port}`, { auth: { token: tokenB }, transports: ['websocket'] });
    await waitFor(sockB, 'connect');
    const evt = await delivered;
    expect(evt.by).toBe(idB);
    expect(evt.messageIds).toContain(res.body.id);
    expect(typeof evt.at).toBe('number');
    expect(evt.statuses.find((s) => s.id === res.body.id)?.status).toBe('delivered');
  });

  it('killed-app push ack: REST POST /conversations/:id/delivered double-ticks with NO socket from B', async () => {
    if (!ready) return;
    // B's app is "killed": no socket at all. The FCM push handler acks over REST instead.
    const offline = waitForMatch<{ userId: string }>(sockA!, 'chat:offline', (e) => e.userId === idB);
    sockB!.close();
    await offline;

    const sent = await request(app).post('/api/messages').set(auth(tokenA)).send({ conversationId: directId, text: 'push me' });
    expect(sent.status).toBe(201);
    expect(sent.body.status).toBe('sent'); // single tick while B is unreachable

    const delivered = waitForMatch<ReceiptEvt>(sockA!, 'chat:delivered', (e) => e.conversationId === directId);
    const ack = await request(app).post(`/api/conversations/${directId}/delivered`).set(auth(tokenB));
    expect(ack.status).toBe(200);
    expect(ack.body.delivered).toBeGreaterThanOrEqual(1);
    const evt = await delivered;
    expect(evt.by).toBe(idB);
    expect(evt.messageIds).toContain(sent.body.id);
    expect(evt.statuses.find((s) => s.id === sent.body.id)?.status).toBe('delivered');

    // Reconnect B for the group tests below (sweep finds nothing pending — already delivered).
    sockB = ioClient(`http://localhost:${port}`, { auth: { token: tokenB }, transports: ['websocket'] });
    await waitFor(sockB, 'connect');
  });

  it('invalid handshake token → auth:invalid + server-side disconnect', async () => {
    if (!ready) return;
    const sock = ioClient(`http://localhost:${port}`, { auth: { token: 'not-a-jwt' }, transports: ['websocket'] });
    const invalid = waitFor(sock, 'auth:invalid');
    const disconnected = waitFor(sock, 'disconnect');
    await invalid;
    await disconnected;
    sock.close();
  });
});

describe('Chat realtime — group', () => {
  it('A creates a group; A → group message reaches B', async () => {
    if (!ready) return;
    const group = await request(app).post('/api/groups').set(auth(tokenA)).send({ name: 'Test Group', memberIds: [idB] });
    expect(group.status).toBe(201);
    groupId = group.body.id;
    createdConvIds.push(groupId);
    expect(group.body.type).toBe('group');
    expect(group.body.memberCount).toBe(2);

    sockB!.emit('chat:join', { conversationId: groupId });
    await delay(150);
    const received = waitFor<{ text: string; conversationId: string }>(sockB!, 'chat:receive');
    await request(app).post('/api/messages').set(auth(tokenA)).send({ conversationId: groupId, text: 'group hi' });
    const evt = await received;
    expect(evt.text).toBe('group hi');
    expect(evt.conversationId).toBe(groupId);
  });
});

describe('Chat — delete group', () => {
  it('creator/super deletes the group + its messages; non-admins are refused', async () => {
    if (!ready) return;
    // Throwaway group with a message.
    const g = await request(app).post('/api/groups').set(auth(tokenA)).send({ name: 'Delete Me', memberIds: [idB] });
    expect(g.status).toBe(201);
    const gid = g.body.id as string;
    createdConvIds.push(gid); // afterAll cleanup is a no-op if already deleted
    await request(app).post('/api/messages').set(auth(tokenA)).send({ conversationId: gid, text: 'bye soon' });
    expect(await MessageModel().countDocuments({ conversationId: new Types.ObjectId(gid) })).toBeGreaterThan(0);

    // A plain member (non-admin, non-creator, non-super) cannot delete.
    const forbidden = await request(app).delete(`/api/groups/${gid}`).set(auth(tokenB));
    expect(forbidden.status).toBe(403);

    // The creator (super admin) can — returns { ok: true }.
    const del = await request(app).delete(`/api/groups/${gid}`).set(auth(tokenA));
    expect(del.status).toBe(200);
    expect(del.body.ok).toBe(true);

    // Conversation + all its messages are gone; fetching it 404s.
    expect(await ConversationModel().findById(gid)).toBeNull();
    expect(await MessageModel().countDocuments({ conversationId: new Types.ObjectId(gid) })).toBe(0);
    const fetch = await request(app).get(`/api/groups/${gid}`).set(auth(tokenA));
    expect(fetch.status).toBe(404);
  });
});

describe('Chat — delete message (for me / for everyone)', () => {
  it('for-me hides the row from that user only and leaves everyone else untouched', async () => {
    if (!ready) return;
    const sent = await request(app).post('/api/messages').set(auth(tokenA)).send({ conversationId: directId, text: 'B hides this' });
    const mid = sent.body.id as string;

    const del = await request(app).delete(`/api/messages/${mid}?scope=me`).set(auth(tokenB));
    expect(del.status).toBe(200);

    const listB = await request(app).get(`/api/conversations/${directId}/messages`).set(auth(tokenB));
    expect(listB.body.some((m: { id: string }) => m.id === mid)).toBe(false);
    const listA = await request(app).get(`/api/conversations/${directId}/messages`).set(auth(tokenA));
    const stillThere = listA.body.find((m: { id: string }) => m.id === mid) as { text: string; deletedForEveryone: boolean };
    expect(stillThere.text).toBe('B hides this'); // a per-user hide never touches the message itself
    expect(stillThere.deletedForEveryone).toBe(false);
  });

  it('for-everyone tombstones the message, clears the chat-list preview, and emits chat:delete', async () => {
    if (!ready) return;
    const sent = await request(app).post('/api/messages').set(auth(tokenA)).send({ conversationId: directId, text: 'secret text' });
    const mid = sent.body.id as string;

    const evt = waitForMatch<{ id: string; conversationId: string }>(sockB!, 'chat:delete', (e) => e.id === mid);
    const del = await request(app).delete(`/api/messages/${mid}?scope=everyone`).set(auth(tokenA));
    expect(del.status).toBe(200);
    expect((await evt).conversationId).toBe(directId);

    // Text is gone from the message for BOTH sides…
    for (const token of [tokenA, tokenB]) {
      const list = await request(app).get(`/api/conversations/${directId}/messages`).set(auth(token));
      const row = list.body.find((m: { id: string }) => m.id === mid) as { text: string; deletedForEveryone: boolean; attachments: unknown[] };
      expect(row.deletedForEveryone).toBe(true);
      expect(row.text).toBe('');
      expect(row.attachments).toEqual([]);
    }
    // …and from the denormalised chat-list preview, which is a separate copy of it.
    const convs = await request(app).get('/api/conversations').set(auth(tokenB));
    const row = convs.body.find((c: { id: string }) => c.id === directId) as { lastMessage: { text: string; type: string } };
    expect(row.lastMessage.text).not.toContain('secret');
    expect(row.lastMessage.type).toBe('system');
  });

  it('only the sender can delete for everyone', async () => {
    if (!ready) return;
    const sent = await request(app).post('/api/messages').set(auth(tokenA)).send({ conversationId: directId, text: 'not yours to unsend' });
    const forbidden = await request(app).delete(`/api/messages/${sent.body.id}?scope=everyone`).set(auth(tokenB));
    expect(forbidden.status).toBe(403);
  });
});
