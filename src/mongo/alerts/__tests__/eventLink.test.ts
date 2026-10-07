// No DB. GET /api/alerts' event list carries an event's https `link` (the card's "Open" button,
// added 2026-10-07 for KGD tickets) — and never a link that is not https, even one written into
// the collection by hand.
const storedDocs: Record<string, unknown>[] = [];

jest.mock('../../connection', () => ({
  appDb: () => ({ collection: () => ({ aggregate: () => ({ toArray: async () => storedDocs }) }) }),
}));
jest.mock('../../access', () => ({
  accessService: { accessForUserId: async (id: string) => ({ userId: id, isSuper: true, branchIds: null }) },
}));
jest.mock('../alertGrants', () => ({ alertGrants: { effectiveFor: async () => [] } }));
jest.mock('../alert.push', () => ({ alertPush: {} }));

import { alertService, isHttpsLink } from '../alert.service';

const doc = (over: Record<string, unknown>) => ({
  _id: 'e1', channelId: 'tk_kgd_crm', source: 'CRM', title: 'Ticket raised', body: '', context: 'KGD · CRM tickets', time: new Date(0), readBy: [], ...over,
});

describe('alert event link', () => {
  beforeEach(() => { storedDocs.length = 0; });

  it('is returned on the event when stored', async () => {
    storedDocs.push(doc({ link: 'https://crm.kingsgroup.example/tickets/TKT-0042' }));
    const { events } = await alertService.listFor('u1');
    expect(events[0]).toMatchObject({ id: 'e1', channelId: 'tk_kgd_crm', link: 'https://crm.kingsgroup.example/tickets/TKT-0042' });
  });

  it('is absent when none was stored, and dropped when it is not https', async () => {
    storedDocs.push(doc({ _id: 'e1' }), doc({ _id: 'e2', link: 'javascript:alert(1)' }), doc({ _id: 'e3', link: 'http://x.example' }));
    const { events } = await alertService.listFor('u1');
    for (const e of events) expect(e).not.toHaveProperty('link');
  });

  it('isHttpsLink', () => {
    expect(isHttpsLink('https://a.example/x')).toBe(true);
    expect(isHttpsLink('http://a.example/x')).toBe(false);
    expect(isHttpsLink(`https://a.example/${'a'.repeat(500)}`)).toBe(false);
    expect(isHttpsLink(undefined)).toBe(false);
  });
});
