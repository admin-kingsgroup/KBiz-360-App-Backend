// reportChat.postMedia, DB-less: storage, the chat service and the lookups are mocked. Pins the
// order that matters — the file is judged BEFORE anything is resolved or stored, and a retry of a
// post that already landed stores nothing.
const save = jest.fn();
jest.mock('../../../storage', () => ({ getStorage: () => ({ save }) }));
jest.mock('../../chat/chat.service', () => ({
  chatService: { postServiceMessage: jest.fn(), findServiceMessageId: jest.fn() },
}));
jest.mock('../../crm.repo', () => ({
  crmRepo: { findUserByEmail: jest.fn(async () => ({ _id: 'u-books', first_name: 'KBiz', last_name: 'Books', email: 'kbiz.books@travkings.com' })), getUserById: jest.fn() },
}));
const rooms = [{ _id: 'c-tickets', name: 'Ticket Support', lastActivityAt: new Date() }, { _id: 'c-other', name: 'BOM Support Desk', lastActivityAt: new Date() }];
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

it('dryRun resolves the room and the sender and writes nothing', async () => {
  const out = await reportChat.postMedia({ group: 'tickets', kind: 'image', dryRun: true, file: { buffer: PNG, name: 'a.png', mime: 'image/png' } });
  expect(out).toMatchObject({ conversationId: 'c-tickets', group: 'Ticket Support', dryRun: true, sender: 'KBiz Books' });
  expect(save).not.toHaveBeenCalled();
});
