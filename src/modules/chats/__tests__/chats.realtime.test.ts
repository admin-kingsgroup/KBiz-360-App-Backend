import { createServer, type Server } from 'http';
import { type AddressInfo } from 'net';
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';
import request from 'supertest';
import { createApp } from '../../../app';
import { initRealtime } from '../../../realtime/socket';
import { prisma } from '../../../db/prisma';

// Realtime — proves Socket.IO delivers message:new to chat-room subscribers when a message is POSTed.
// Boots a real HTTP+Socket.IO server; self-skips without a seeded DB.
const app = createApp();
let server: Server;
let port = 0;
let token = '';
let dbReady = false;
let client: ClientSocket | null = null;

beforeAll(async () => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    const a = await prisma.user.findFirst({ where: { email: 'afshin@kbiz360.com' } });
    dbReady = Boolean(a?.passwordHash);
  } catch {
    /* skip */
  }
  if (!dbReady) return;
  server = createServer(app);
  initRealtime(server);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  port = (server.address() as AddressInfo).port;
  token = (await request(app).post('/api/auth/login').send({ identifier: 'afshin@kbiz360.com', password: 'kbiz360' })).body
    .accessToken;
});

afterAll(async () => {
  if (client) client.close();
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  if (dbReady) await prisma.message.deleteMany({ where: { chatId: 'u5' } });
  await prisma.$disconnect();
});

describe('Chat realtime (Socket.IO)', () => {
  it('broadcasts message:new to subscribers of the chat room', async () => {
    if (!dbReady) return;
    await new Promise<void>((resolve, reject) => {
      const c = ioClient(`http://localhost:${port}`, { auth: { token }, transports: ['websocket'] });
      client = c;
      const timer = setTimeout(() => reject(new Error('timeout: no message:new received')), 5000);

      c.on('message:new', (msg: { chatId: string; body: string; senderId: string }) => {
        try {
          expect(msg.chatId).toBe('u5');
          expect(msg.body).toBe('realtime hello');
          expect(msg.senderId).toBe('a1');
          clearTimeout(timer);
          resolve();
        } catch (e) {
          reject(e as Error);
        }
      });

      c.on('connect', () => {
        c.emit('chat:join', { chatId: 'u5' });
        // After the join is registered, POST a message via REST → server emits message:new to the room.
        setTimeout(() => {
          void request(app)
            .post('/api/messages')
            .set({ Authorization: `Bearer ${token}` })
            .send({ chatId: 'u5', body: 'realtime hello' })
            .end(() => undefined);
        }, 250);
      });

      c.on('connect_error', (err) => reject(err));
    });
  }, 10000);
});
