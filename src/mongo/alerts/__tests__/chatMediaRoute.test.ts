import express from 'express';
import request from 'supertest';
import { config } from '../../../config';
import { errorHandler } from '../../../common/errors';

// POST /api/alerts/chat (group 'tickets') and POST /api/alerts/chat/media — the HTTP contract the
// ERP and CRM ticket emitters code against (owner, 2026-10-12: tickets go to "Ticket Support" with
// all their attachments). reportChat is mocked: these pin auth, addressing and field parsing.
jest.mock('../reportChat.service', () => ({
  reportChat: { post: jest.fn(), postMedia: jest.fn(), postBundle: jest.fn() },
}));
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { reportChat } = require('../reportChat.service') as { reportChat: { post: jest.Mock; postMedia: jest.Mock; postBundle: jest.Mock } };
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { alertsIngestRouter } = require('../alertsIngest.router') as typeof import('../alertsIngest.router');

const TOKEN = 'test-ingest-token';
const app = express();
app.use(express.json({ limit: '5mb' }));
app.use('/api/alerts', alertsIngestRouter);
app.use(errorHandler);

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
const OUT = { conversationId: 'c1', group: 'Ticket Support', messageId: 'm1', duplicate: false };

beforeAll(() => { (config.alerts as { ingestToken: string }).ingestToken = TOKEN; });
beforeEach(() => {
  reportChat.post.mockReset().mockResolvedValue(OUT);
  reportChat.postMedia.mockReset().mockResolvedValue(OUT);
  reportChat.postBundle.mockReset().mockResolvedValue(OUT);
});

describe('POST /api/alerts/chat — group tickets', () => {
  it('needs no branchCode: the room is company-wide', async () => {
    const res = await request(app).post('/api/alerts/chat').set('Authorization', `Bearer ${TOKEN}`)
      .send({ group: 'tickets', title: 'New ticket', body: 'TKT-00042', dedupeKey: 'erp-ticket-TKT-00042' });
    expect(res.status).toBe(200);
    expect(reportChat.post).toHaveBeenCalledWith(expect.objectContaining({ group: 'tickets', branchCode: undefined, dedupeKey: 'erp-ticket-TKT-00042' }));
  });

  it('every other group still needs a branch or a conversation', async () => {
    const res = await request(app).post('/api/alerts/chat').set('Authorization', `Bearer ${TOKEN}`).send({ group: 'finance', title: 't' });
    expect(res.status).toBe(400);
    expect(reportChat.post).not.toHaveBeenCalled();
  });
});

describe('POST /api/alerts/chat/media', () => {
  const media = () => request(app).post('/api/alerts/chat/media').set('Authorization', `Bearer ${TOKEN}`);

  it('passes the file, the kind and the parsed fields through', async () => {
    const res = await media()
      .field('group', 'tickets').field('kind', 'image').field('caption', 'TKT-00042 · Screenshot 1 of 2')
      .field('dedupeKey', 'erp-ticket-TKT-00042-1').field('durationMs', '0').field('dryRun', 'false')
      .attach('file', PNG, { filename: 'shot.png', contentType: 'image/png' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, ...OUT });
    const arg = reportChat.postMedia.mock.calls[0][0];
    expect(arg).toMatchObject({ group: 'tickets', kind: 'image', caption: 'TKT-00042 · Screenshot 1 of 2', dedupeKey: 'erp-ticket-TKT-00042-1', durationMs: 0, dryRun: false });
    expect(arg.file).toMatchObject({ name: 'shot.png', mime: 'image/png' });
    expect(Buffer.compare(arg.file.buffer, PNG)).toBe(0);
  });

  it('dryRun "true" arrives as a boolean', async () => {
    await media().field('group', 'tickets').field('kind', 'image').field('dryRun', 'true')
      .attach('file', PNG, { filename: 'a.png', contentType: 'image/png' });
    expect(reportChat.postMedia.mock.calls[0][0].dryRun).toBe(true);
  });

  it('refuses without the service token', async () => {
    const res = await request(app).post('/api/alerts/chat/media').field('group', 'tickets').field('kind', 'image')
      .attach('file', PNG, { filename: 'a.png', contentType: 'image/png' });
    expect(res.status).toBe(401);
    expect(reportChat.postMedia).not.toHaveBeenCalled();
  });

  it('400 without a file, with an unknown kind, or with nowhere to post', async () => {
    expect((await media().field('group', 'tickets').field('kind', 'image')).status).toBe(400);
    expect((await media().field('group', 'tickets').field('kind', 'sticker')
      .attach('file', PNG, { filename: 'a.png', contentType: 'image/png' })).status).toBe(400);
    expect((await media().field('group', 'finance').field('kind', 'image')
      .attach('file', PNG, { filename: 'a.png', contentType: 'image/png' })).status).toBe(400);
    expect(reportChat.postMedia).not.toHaveBeenCalled();
  });

  it('413 for a file over the ceiling', async () => {
    const big = Buffer.alloc(27 * 1024 * 1024);
    const res = await media().field('group', 'tickets').field('kind', 'video')
      .attach('file', big, { filename: 'rec.webm', contentType: 'video/webm' });
    expect(res.status).toBe(413);
    expect(reportChat.postMedia).not.toHaveBeenCalled();
  });
});

describe('POST /api/alerts/chat/bundle — one ticket, one message', () => {
  const bundle = () => request(app).post('/api/alerts/chat/bundle').set('Authorization', `Bearer ${TOKEN}`);
  const WEBM = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81]);

  it('passes the text and every file, each with its own kind and duration, in order', async () => {
    const res = await bundle()
      .field('group', 'tickets').field('title', '*New ERP ticket — test*').field('body', 'TKT-00009 · Medium · Bug')
      .field('kinds', 'voice,image,video').field('durations', '4000,0,0').field('dedupeKey', 'erp-ticket-TKT-00009')
      .field('raisedBy', 'Developer@KingsGroupCo.com')
      .attach('files', WEBM, { filename: 'voice-note.webm', contentType: 'audio/webm' })
      .attach('files', PNG, { filename: 'shot.png', contentType: 'image/png' })
      .attach('files', WEBM, { filename: 'screen-recording.webm', contentType: 'video/webm' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, ...OUT });
    const arg = reportChat.postBundle.mock.calls[0][0];
    expect(arg).toMatchObject({ group: 'tickets', title: '*New ERP ticket — test*', body: 'TKT-00009 · Medium · Bug', dedupeKey: 'erp-ticket-TKT-00009', raisedBy: 'developer@kingsgroupco.com' });
    expect(arg.files.map((f: { kind: string; name: string; mime: string; durationMs?: number }) => [f.kind, f.name, f.mime, f.durationMs])).toEqual([
      ['voice', 'voice-note.webm', 'audio/webm', 4000],
      ['image', 'shot.png', 'image/png', 0],
      ['video', 'screen-recording.webm', 'video/webm', 0],
    ]);
  });

  it('the CRLF line breaks of a multipart field are stored as plain newlines', async () => {
    await bundle().field('group', 'tickets').field('title', 'New ticket').field('body', 'TKT-00009\r\nRaised by me\r\n\r\nOpen in Books')
      .field('kinds', 'image').attach('files', PNG, { filename: 'a.png', contentType: 'image/png' });
    expect(reportChat.postBundle.mock.calls[0][0].body).toBe('TKT-00009\nRaised by me\n\nOpen in Books');
  });

  it('400 when the kinds do not match the files, a kind is unknown, or there are no files', async () => {
    expect((await bundle().field('group', 'tickets').field('title', 't').field('kinds', 'image,video')
      .attach('files', PNG, { filename: 'a.png', contentType: 'image/png' })).status).toBe(400);
    expect((await bundle().field('group', 'tickets').field('title', 't').field('kinds', 'sticker')
      .attach('files', PNG, { filename: 'a.png', contentType: 'image/png' })).status).toBe(400);
    expect((await bundle().field('group', 'tickets').field('title', 't').field('kinds', 'image')).status).toBe(400);
    expect(reportChat.postBundle).not.toHaveBeenCalled();
  });

  it('refuses without the service token', async () => {
    const res = await request(app).post('/api/alerts/chat/bundle').field('group', 'tickets').field('title', 't').field('kinds', 'image')
      .attach('files', PNG, { filename: 'a.png', contentType: 'image/png' });
    expect(res.status).toBe(401);
    expect(reportChat.postBundle).not.toHaveBeenCalled();
  });

  it('413 when the files together are over the ceiling', async () => {
    const half = Buffer.alloc(14 * 1024 * 1024);
    const res = await bundle().field('group', 'tickets').field('title', 't').field('kinds', 'video,video')
      .attach('files', half, { filename: 'a.webm', contentType: 'video/webm' })
      .attach('files', half, { filename: 'b.webm', contentType: 'video/webm' });
    expect(res.status).toBe(413);
    expect(reportChat.postBundle).not.toHaveBeenCalled();
  });
});
