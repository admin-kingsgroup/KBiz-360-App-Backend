// reportChat.postMedia, DB-less: storage, the chat service and the lookups are mocked. Pins the
// order that matters — the file is judged BEFORE anything is resolved or stored, and a retry of a
// post that already landed stores nothing.
const save = jest.fn();
jest.mock('../../../storage', () => ({ getStorage: () => ({ save }) }));
jest.mock('../../chat/chat.service', () => ({
  chatService: { postServiceMessage: jest.fn(), findServiceMessageId: jest.fn() },
}));
// Users by email: the KBiz Books sender, a ticket raiser, and raisers who may not use the app.
const people: Record<string, object> = {
  'kbiz.books@travkings.com': { _id: 'u-books', first_name: 'KBiz', last_name: 'Books', email: 'kbiz.books@travkings.com' },
  'raiser@example.com': { _id: 'u-raiser', first_name: 'Test', last_name: 'Raiser', email: 'raiser@example.com', status: 'active' },
  'left@example.com': { _id: 'u-left', first_name: 'Gone', last_name: 'User', email: 'left@example.com', status: 'inactive' },
  'noapp@example.com': { _id: 'u-noapp', first_name: 'No', last_name: 'App', email: 'noapp@example.com', access: { app: false } },
};
jest.mock('../../crm.repo', () => ({
  crmRepo: { findUserByEmail: jest.fn(async (email: string) => people[email] ?? null), getUserById: jest.fn() },
}));
const rooms = [{ _id: 'c-tickets', name: 'Ticket Support', lastActivityAt: new Date() }, { _id: 'c-other', name: 'BOM Support Desk', lastActivityAt: new Date() }, { _id: 'c-finance', name: 'HQ - BOM Finance', lastActivityAt: new Date() }];
jest.mock('../../chat/chat.models', () => ({
  ConversationModel: () => ({
    find: () => ({ select: () => ({ lean: async () => rooms }) }),
    findById: () => ({ select: () => ({ lean: async () => null }) }),
  }),
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { chatService } = require('../../chat/chat.service') as { chatService: { postServiceMessage: jest.Mock; findServiceMessageId: jest.Mock } };
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { reportChat } = require('../reportChat.service') as typeof import('../reportChat.service');

const PNG = (() => {
  const b = Buffer.alloc(33);
  b.writeUInt32BE(0x89504e47, 0); b.writeUInt32BE(0x0d0a1a0a, 4); b.write('IHDR', 12, 'latin1');
  b.writeUInt32BE(1080, 16); b.writeUInt32BE(2400, 20);
  return b;
})();
const WEBM = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81]);

beforeEach(() => {
  save.mockReset().mockImplementation(async ({ filename }: { filename: string }) => ({ key: `uploads/x-${filename}`, url: `https://cdn/uploads/x-${filename}` }));
  chatService.postServiceMessage.mockReset().mockResolvedValue({ id: 'm1' });
  chatService.findServiceMessageId.mockReset().mockResolvedValue(null);
});

it('a screenshot lands in "Ticket Support" as a photo message, sized, under its verified name', async () => {
  const out = await reportChat.postMedia({ group: 'tickets', kind: 'image', caption: 'TKT-00042 · Screenshot 1 of 1', dedupeKey: 'erp-ticket-TKT-00042-a1', file: { buffer: PNG, name: 'shot.html', mime: 'image/png' } });
  expect(out).toEqual({ conversationId: 'c-tickets', group: 'Ticket Support', messageId: 'm1', duplicate: false, attachmentUrl: 'https://cdn/uploads/x-shot.png' });
  expect(save).toHaveBeenCalledWith(expect.objectContaining({ filename: 'shot.png', mimeType: 'image/png' }));
  expect(chatService.postServiceMessage).toHaveBeenCalledWith('c-tickets', 'u-books', {
    text: 'TKT-00042 · Screenshot 1 of 1',
    attachments: [{ url: 'https://cdn/uploads/x-shot.png', name: 'shot.png', size: PNG.length, mime: 'image/png', width: 1080, height: 2400 }],
    mediaType: 'image',
    clientId: 'report:erp-ticket-TKT-00042-a1',
    senderName: 'KBiz Books',
  });
});

it('a voice note recorded as video/webm is posted as a voice message, served as audio', async () => {
  await reportChat.postMedia({ group: 'tickets', kind: 'voice', durationMs: 12_400, file: { buffer: WEBM, name: 'voice-note.webm', mime: 'video/webm' } });
  expect(save).toHaveBeenCalledWith(expect.objectContaining({ mimeType: 'audio/webm' }));
  expect(chatService.postServiceMessage.mock.calls[0][2]).toMatchObject({ mediaType: 'voice', attachments: [expect.objectContaining({ mime: 'audio/webm', durationMs: 12_400 })] });
});

it('a file that is not what it claims is refused before anything is stored or posted', async () => {
  await expect(reportChat.postMedia({ group: 'tickets', kind: 'image', file: { buffer: Buffer.from('<html>'), name: 'x.png', mime: 'image/png' } }))
    .rejects.toThrow('The file is not a valid image/png');
  expect(save).not.toHaveBeenCalled();
  expect(chatService.postServiceMessage).not.toHaveBeenCalled();
});

it('a retry of a post that already landed stores nothing and answers duplicate', async () => {
  chatService.findServiceMessageId.mockResolvedValue('m-earlier');
  const out = await reportChat.postMedia({ group: 'tickets', kind: 'image', dedupeKey: 'k', file: { buffer: PNG, name: 'a.png', mime: 'image/png' } });
  expect(out).toEqual({ conversationId: 'c-tickets', group: 'Ticket Support', messageId: 'm-earlier', duplicate: true });
  expect(chatService.findServiceMessageId).toHaveBeenCalledWith('c-tickets', 'report:k');
  expect(save).not.toHaveBeenCalled();
  expect(chatService.postServiceMessage).not.toHaveBeenCalled();
});

describe('postBundle — a ticket as ONE message', () => {
  const files = () => [
    { kind: 'voice' as const, buffer: WEBM, name: 'voice-note-1.webm', mime: 'video/webm', durationMs: 4_000 },
    { kind: 'image' as const, buffer: PNG, name: 'Screenshot 1.png', mime: 'image/png' },
    { kind: 'video' as const, buffer: WEBM, name: 'screen-recording-1.webm', mime: 'video/webm' },
  ];

  it('one message: the text, then every file with its own kind; titled in the chat list', async () => {
    const out = await reportChat.postBundle({ group: 'tickets', title: '*New ERP ticket — test*', body: 'TKT-00009 · Medium · Bug', dedupeKey: 'erp-ticket-TKT-00009', files: files() });
    expect(out).toMatchObject({ conversationId: 'c-tickets', group: 'Ticket Support', messageId: 'm1', duplicate: false });
    expect(save).toHaveBeenCalledTimes(3);
    expect(chatService.postServiceMessage).toHaveBeenCalledTimes(1);
    expect(chatService.postServiceMessage).toHaveBeenCalledWith('c-tickets', 'u-books', {
      text: '*New ERP ticket — test*\nTKT-00009 · Medium · Bug',
      attachments: [
        { url: 'https://cdn/uploads/x-voice-note-1.webm', name: 'voice-note-1.webm', size: WEBM.length, mime: 'audio/webm', kind: 'voice', durationMs: 4_000 },
        { url: 'https://cdn/uploads/x-Screenshot_1.png', name: 'Screenshot_1.png', size: PNG.length, mime: 'image/png', kind: 'image', width: 1080, height: 2400 },
        { url: 'https://cdn/uploads/x-screen-recording-1.webm', name: 'screen-recording-1.webm', size: WEBM.length, mime: 'video/webm', kind: 'video' },
      ],
      // An older phone build ignores `kind` and draws every file as a document tile — still openable.
      mediaType: 'document',
      clientId: 'report:erp-ticket-TKT-00009',
      senderName: 'KBiz Books',
      preview: '📎 New ERP ticket — test',
    });
  });

  // Owner, 2026-10-13: the bubble shows who raised the ticket, not "KBiz Books".
  it('is sent as the person who raised the ticket', async () => {
    const out = await reportChat.postBundle({ group: 'tickets', title: 't', raisedBy: 'Raiser@Example.com', files: files() });
    expect(chatService.postServiceMessage.mock.calls[0][1]).toBe('u-raiser');
    expect(chatService.postServiceMessage.mock.calls[0][2]).toMatchObject({ senderName: 'Test Raiser' });
    expect(out.sender).toBe('Test Raiser');
  });

  it('falls back to KBiz Books for an unknown, inactive or app-barred raiser, or no raiser at all', async () => {
    for (const raisedBy of ['nobody@example.com', 'left@example.com', 'noapp@example.com', undefined]) {
      chatService.postServiceMessage.mockClear();
      await reportChat.postBundle({ group: 'tickets', title: 't', raisedBy, files: files() });
      expect([raisedBy, chatService.postServiceMessage.mock.calls[0][1]]).toEqual([raisedBy, 'u-books']);
    }
  });

  it('a raiser is honoured in the tickets room only — a report feed stays KBiz Books', async () => {
    await reportChat.postBundle({ group: 'finance', branchCode: 'BOM', title: 't', raisedBy: 'raiser@example.com', files: files() });
    expect(chatService.postServiceMessage.mock.calls[0][0]).toBe('c-finance');
    expect(chatService.postServiceMessage.mock.calls[0][1]).toBe('u-books');
  });

  it('one bad file refuses the whole bundle before anything is stored or posted', async () => {
    const bad = [...files(), { kind: 'image' as const, buffer: Buffer.from('<html>'), name: 'x.png', mime: 'image/png' }];
    await expect(reportChat.postBundle({ group: 'tickets', title: 't', files: bad })).rejects.toThrow('File 4 (x.png): The file is not a valid image/png');
    expect(save).not.toHaveBeenCalled();
    expect(chatService.postServiceMessage).not.toHaveBeenCalled();
  });

  it('a retry of a bundle that already landed stores nothing and answers duplicate', async () => {
    chatService.findServiceMessageId.mockResolvedValue('m-earlier');
    const out = await reportChat.postBundle({ group: 'tickets', title: 't', dedupeKey: 'erp-ticket-TKT-00009', files: files() });
    expect(out).toEqual({ conversationId: 'c-tickets', group: 'Ticket Support', messageId: 'm-earlier', duplicate: true });
    expect(save).not.toHaveBeenCalled();
  });
});

it('dryRun resolves the room and the sender and writes nothing', async () => {
  const out = await reportChat.postMedia({ group: 'tickets', kind: 'image', dryRun: true, file: { buffer: PNG, name: 'a.png', mime: 'image/png' } });
  expect(out).toMatchObject({ conversationId: 'c-tickets', group: 'Ticket Support', dryRun: true, sender: 'KBiz Books' });
  expect(save).not.toHaveBeenCalled();
});
