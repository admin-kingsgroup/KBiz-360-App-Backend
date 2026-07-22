import fs from 'fs';
import path from 'path';
import request from 'supertest';
import { createApp } from '../../../app';
import { prisma } from '../../../db/prisma';
import { config } from '../../../config';

// Integration — upload via multipart → LocalStorageAdapter → { id, url } → served by express.static.
const app = createApp();
const SUPER = { identifier: 'afshin@kbiz360.com', password: 'kbiz360' };

let dbReady = false;
const created: string[] = []; // storage keys to clean up
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const tok = async () => (await request(app).post('/api/auth/login').send(SUPER)).body.accessToken as string;

beforeAll(async () => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    const a = await prisma.user.findFirst({ where: { email: SUPER.identifier } });
    dbReady = Boolean(a?.passwordHash);
  } catch {
    /* skip */
  }
});

afterAll(async () => {
  for (const key of created) {
    try {
      await fs.promises.unlink(path.join(config.storage.localDir, key));
    } catch {
      /* ignore */
    }
  }
  if (dbReady && created.length) await prisma.upload.deleteMany({ where: { storageKey: { in: created } } });
  await prisma.$disconnect();
});

describe('Uploads — POST /uploads (local adapter)', () => {
  it('uploads a file and serves it back at the returned url', async () => {
    if (!dbReady) return;
    const res = await request(app)
      .post('/api/uploads')
      .set(auth(await tok()))
      .attach('file', Buffer.from('hello world'), 'note.txt');
    expect(res.status).toBe(201);
    expect(res.body.id).toBeTruthy();
    expect(res.body.url).toMatch(/^\/uploads\//);
    created.push(res.body.url.replace('/uploads/', ''));

    const served = await request(app).get(res.body.url);
    expect(served.status).toBe(200);
    expect(served.text).toBe('hello world');
  });

  it('POST /uploads with no file → 400', async () => {
    if (!dbReady) return;
    const res = await request(app).post('/api/uploads').set(auth(await tok()));
    expect(res.status).toBe(400);
  });

  it('POST /uploads without auth → 401', async () => {
    if (!dbReady) return;
    const res = await request(app).post('/api/uploads').attach('file', Buffer.from('x'), 'x.txt');
    expect(res.status).toBe(401);
  });
});
