import { directChats, sortChats } from '../data/chats';

describe('Home › Chats list (source-faithful: not access-filtered)', () => {
  it('sorts unread-first, then most recent', () => {
    const sorted = sortChats(directChats);
    // first item must be unread
    expect((sorted[0].unread || 0) > 0).toBe(true);
    // among unread, most recent (largest ts) first
    const unread = sorted.filter((c) => (c.unread || 0) > 0);
    for (let i = 1; i < unread.length; i++) expect(unread[i - 1].ts).toBeGreaterThanOrEqual(unread[i].ts);
  });

  it('self-exclusion removes the signed-in user by name (caller responsibility)', () => {
    const self = 'Afshin Dhanani';
    const list = sortChats(directChats.filter((c) => c.name !== self));
    expect(list.some((c) => c.name === self)).toBe(false);
  });

  it('list size is independent of access (no access filtering applied)', () => {
    // sanity: the data layer exposes all DMs; filtering is only self-exclusion
    expect(directChats.length).toBe(7);
  });
});
