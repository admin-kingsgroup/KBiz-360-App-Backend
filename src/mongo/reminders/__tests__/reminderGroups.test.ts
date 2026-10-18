// No DB. One create call = one groupId on every copy; an edit that adds people joins the existing
// group (creator only); a field edit can replace or remove the picture and stamp a groupId.
import { Types } from 'mongoose';

type Doc = Record<string, unknown> & { _id: Types.ObjectId; byId: string; forId: string; groupId: string | null };
const docs: Doc[] = [];

jest.mock('../reminder.repository', () => ({
  reminderRepo: {
    create: async (data: Partial<Doc>) => {
      const doc = { _id: new Types.ObjectId(), groupId: null, imageUrl: null, ...data } as Doc;
      docs.push(doc);
      return { ...doc, toObject: () => doc };
    },
    byId: async (id: string) => docs.find((d) => String(d._id) === id) ?? null,
    update: async (id: string, set: Partial<Doc>) => { Object.assign(docs.find((d) => String(d._id) === id)!, set); },
    groupOwnedBy: async (groupId: string, byId: string) =>
      docs.some((d) => d.byId === byId && (d.groupId === groupId || String(d._id) === groupId)),
  },
}));
jest.mock('../../crm.repo', () => ({
  crmRepo: {
    getUserById: async (id: string) => ({ _id: id, first_name: id }),
    listUsers: async () => [],
  },
}));
jest.mock('../../access', () => ({ accessService: { accessForUserId: async () => null } }));
jest.mock('../../chat/chat.events', () => ({ emitToUser: () => undefined }));
jest.mock('../reminder.push', () => ({ reminderPush: { sendAssigned: async () => undefined } }));

import { remindersService } from '../reminder.service';

beforeEach(() => { docs.length = 0; });

describe('reminder groups', () => {
  it('gives every copy of one create call the same groupId', async () => {
    const recs = await remindersService.create('afshin', { text: 'OWM setup', forIds: ['afshin', 'sughra'] });
    expect(recs).toHaveLength(2);
    expect(recs[0].groupId).toMatch(/^[0-9a-f]{24}$/);
    expect(recs[1].groupId).toBe(recs[0].groupId);
  });

  it('two create calls are two groups', async () => {
    const [a] = await remindersService.create('afshin', { text: 'One', forIds: ['afshin'] });
    const [b] = await remindersService.create('afshin', { text: 'Two', forIds: ['afshin'] });
    expect(a.groupId).not.toBe(b.groupId);
  });

  it('an edit adding a person joins the existing group', async () => {
    const [first] = await remindersService.create('afshin', { text: 'OWM setup', forIds: ['afshin'] });
    const [added] = await remindersService.create('afshin', { text: 'OWM setup', forIds: ['sughra'], groupId: first.groupId });
    expect(added.groupId).toBe(first.groupId);
  });

  it('an older reminder (no groupId) is joined by the id of one of its copies', async () => {
    docs.push({ _id: new Types.ObjectId(), byId: 'afshin', forId: 'afshin', groupId: null, text: 'Old', state: 'pending' });
    const oldId = String(docs[0]._id);
    const [added] = await remindersService.create('afshin', { text: 'Old', forIds: ['sughra'], groupId: oldId });
    expect(added.groupId).toBe(oldId);
  });

  it('nobody else can add people to my reminder', async () => {
    const [mine] = await remindersService.create('afshin', { text: 'Mine', forIds: ['afshin'] });
    await expect(remindersService.create('faiz', { text: 'Mine', forIds: ['faiz'], groupId: mine.groupId })).rejects.toThrow(/creator/);
  });

  it('a field edit replaces or removes the picture and stamps a groupId', async () => {
    docs.push({ _id: new Types.ObjectId(), byId: 'afshin', forId: 'afshin', groupId: null, text: 'Old', state: 'pending', imageUrl: null });
    const id = String(docs[0]._id);
    const g = new Types.ObjectId().toHexString();
    let out = await remindersService.patch(id, { text: 'Old', imageUrl: 'https://s3/pic.jpg', groupId: g }, 'afshin');
    expect(out.reminder.image).toBe('https://s3/pic.jpg');
    expect(out.reminder.groupId).toBe(g);
    out = await remindersService.patch(id, { imageUrl: null }, 'afshin');
    expect(out.reminder.image).toBeUndefined();
    out = await remindersService.patch(id, { text: 'Text only' }, 'afshin');
    expect(out.reminder.groupId).toBe(g); // untouched when not sent
  });
});
