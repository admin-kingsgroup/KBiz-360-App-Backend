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

const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
function waitFor<T = unknown>(sock: ClientSocket, event: string, ms = 5000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), ms);
    sock.once(event, (data: T) => { clearTimeout(timer); resolve(data); });
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

  it('B reads → A gets chat:read', async () => {
    if (!ready) return;
    const read = waitFor<{ by: string; conversationId: string }>(sockA!, 'chat:read');
    sockB!.emit('chat:read', { conversationId: directId });
    const evt = await read;
    expect(evt.by).toBe(idB);
    expect(evt.conversationId).toBe(directId);
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

  it('GET /conversations lists the direct conversation for both', async () => {
    if (!ready) return;
    const listA = await request(app).get('/api/conversations').set(auth(tokenA));
    const listB = await request(app).get('/api/conversations').set(auth(tokenB));
    expect(listA.body.some((c: { id: string }) => c.id === directId)).toBe(true);
    expect(listB.body.some((c: { id: string }) => c.id === directId)).toBe(true);
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
