// No DB. Owner 2026-11-03: a reminder someone wrote FOR the Owner could not be edited by him. A field
// edit is now open to the creator or a manager (the same people who may delete it); who it is for
// stays the creator's.
import { Types } from 'mongoose';

type Doc = Record<string, unknown> & { _id: Types.ObjectId; byId: string; forId: string; groupId: string | null };
const docs: Doc[] = [];
const emitted: Array<[string, string]> = [];

jest.mock('../reminder.repository', () => ({
  reminderRepo: {
    byId: async (id: string) => docs.find((d) => String(d._id) === id) ?? null,
    update: async (id: string, set: Partial<Doc>) => { Object.assign(docs.find((d) => String(d._id) === id)!, set); },
  },
}));
jest.mock('../../crm.repo', () => ({
  crmRepo: {
    getUserById: async (id: string) => ({ _id: id, first_name: id }),
    listUsers: async () => [],
  },
}));
// afshin = super admin, farhan = company manager, faiz / shehzad = staff.
const LEVEL: Record<string, number> = { afshin: 1, farhan: 2, faiz: 5, shehzad: 5 };
jest.mock('../../access', () => ({
  accessService: { accessForUserId: async (id: string) => (id in LEVEL ? { canManage: LEVEL[id] <= 2 } : null) },
}));
jest.mock('../../chat/chat.events', () => ({ emitToUser: (to: string, ev: string) => { emitted.push([to, ev]); } }));
jest.mock('../reminder.push', () => ({ reminderPush: { sendAssigned: async () => undefined } }));

import { remindersService } from '../reminder.service';

const seed = (over: Partial<Doc> = {}): string => {
  const doc = { _id: new Types.ObjectId(), byId: 'shehzad', forId: 'afshin', groupId: null, text: 'Warehouse discussion', section: 'today', state: 'pending', whenLabel: null, dueAt: null, imageUrl: null, ...over } as Doc;
  docs.push(doc);
  return String(doc._id);
};

beforeEach(() => { docs.length = 0; emitted.length = 0; });

describe('who may edit a reminder', () => {
  it('the Owner edits a reminder someone wrote for him', async () => {
    const id = seed();
    const out = await remindersService.patch(id, { text: 'Warehouse discussion — add Bhiwandi rates' }, 'afshin');
    expect(out.reminder.text).toBe('Warehouse discussion — add Bhiwandi rates');
    expect(out.reminder.byId).toBe('shehzad'); // still Shehzad's reminder
    expect(emitted).toContainEqual(['shehzad', 'reminder:update']); // the creator's list refreshes
  });

  it('a company manager may edit too, and move the due date', async () => {
    const id = seed({ forId: 'farhan' });
    const due = new Date(Date.now() + 86_400_000).toISOString();
    const out = await remindersService.patch(id, { dueAt: due, when: 'Tomorrow' }, 'farhan');
    expect(out.reminder.dueAt).toBe(due);
  });

  it('staff cannot edit a reminder someone else wrote for them', async () => {
    const id = seed({ byId: 'afshin', forId: 'faiz' });
    await expect(remindersService.patch(id, { text: 'changed' }, 'faiz')).rejects.toThrow(/creator or a manager/);
    expect(docs[0].text).toBe('Warehouse discussion');
  });

  it('the creator still edits as before', async () => {
    const id = seed({ byId: 'faiz', forId: 'shehzad' });
    const out = await remindersService.patch(id, { text: 'Call the landlord' }, 'faiz');
    expect(out.reminder.text).toBe('Call the landlord');
    expect(emitted).toEqual([['shehzad', 'reminder:update']]); // only the assignee is told; the creator made it
  });

  it('a manager still cannot change who it is for', async () => {
    const id = seed();
    await expect(remindersService.patch(id, { forId: 'faiz' }, 'afshin')).rejects.toThrow(/creator/);
    expect(docs[0].forId).toBe('afshin');
  });
});
