const mockCreateIndex = jest.fn().mockResolvedValue('ok');

// app_sessions is a raw-driver collection; mock the connection so ensureSessionIndexes can be
// exercised without a live Mongo, and assert it declares the exact indexes the queries need.
jest.mock('../connection', () => ({
  appDb: () => ({ collection: () => ({ createIndex: mockCreateIndex }) }),
  crmDb: () => ({ collection: () => ({}) }),
  crmWriteDb: () => ({ collection: () => ({}) }),
}));

import { ensureSessionIndexes } from '../auth';

describe('ensureSessionIndexes', () => {
  beforeEach(() => mockCreateIndex.mockClear());

  it('creates a unique tokenHash index (refresh + logout lookups)', async () => {
    await ensureSessionIndexes();
    expect(mockCreateIndex).toHaveBeenCalledWith({ tokenHash: 1 }, { unique: true });
  });

  it('creates a userId index (revokeAllSessions)', async () => {
    await ensureSessionIndexes();
    expect(mockCreateIndex).toHaveBeenCalledWith({ userId: 1 });
  });

  it('creates a TTL index on expiresAt so expired/rotated sessions are reaped automatically', async () => {
    await ensureSessionIndexes();
    expect(mockCreateIndex).toHaveBeenCalledWith({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  });

  it('declares exactly those three indexes (no duplicate/extra indexes)', async () => {
    await ensureSessionIndexes();
    expect(mockCreateIndex).toHaveBeenCalledTimes(3);
  });
});
