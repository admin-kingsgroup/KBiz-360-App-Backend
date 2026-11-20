// No DB, no network. What Expo says about a task push is kept on the notification (owner, 2026-11-20):
// first its ticket per phone (accepted or refused), then, about 15 minutes later, its receipt (FCM / APNs
// took it or not). Until now the reply was thrown away, so a refused push left no trace.
let tokens: string[] = [];
let pushEnabled = true;
jest.mock('../../calls/call.repository', () => ({
  callDeviceRepo: { tokensForUser: async () => tokens },
}));
jest.mock('../../../config', () => ({ config: { push: { get enabled() { return pushEnabled; } } } }));

// task_notifications, in memory: only what the receipt check reads and writes.
interface Row { _id: string; userId: string; event: string; sentAt: Date; push: Record<string, unknown> | null }
let rows: Row[] = [];
const updates: Array<{ id: string; set: Record<string, unknown> }> = [];
jest.mock('../task.model', () => ({
  TaskNotificationModel: () => ({
    find: (q: { sentAt: { $gte: Date; $lte: Date } }) => ({
      limit: () => ({
        lean: async () => rows.filter((r) => {
          const p = r.push as { checkedAt: Date | null; ticketIds: string[] } | null;
          return !!p && p.checkedAt === null && p.ticketIds.length > 0 && r.sentAt >= q.sentAt.$gte && r.sentAt <= q.sentAt.$lte;
        }),
      }),
    }),
    updateOne: async (filter: { _id: string }, update: { $set: Record<string, unknown> }) => { updates.push({ id: filter._id, set: update.$set }); },
  }),
}));

import { taskPush } from '../task.push';

const A = 'ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]';
const B = 'ExponentPushToken[bbbbbbbbbbbbbbbbbbbbbb]';
const msg = { title: 'Afshin assigned you a task', body: 'Close October books', data: { type: 'task' }, urgent: false };
const reply = (body: unknown, status = 200): Response => ({ status, ok: status < 400, json: async () => body } as unknown as Response);
const fetchMock = jest.fn<Promise<Response>, [string, RequestInit]>();
const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
const printed = (): string => JSON.stringify([...warn.mock.calls, ...log.mock.calls]);

beforeAll(() => { (global as unknown as { fetch: unknown }).fetch = fetchMock; });
afterAll(() => { warn.mockRestore(); log.mockRestore(); });
beforeEach(() => { tokens = [A, B]; pushEnabled = true; rows = []; updates.length = 0; fetchMock.mockReset(); warn.mockClear(); log.mockClear(); });

describe('sending a task push — what Expo answered', () => {
  it('nobody to send to when the person has no phone registered', async () => {
    tokens = ['not-an-expo-token'];
    expect(await taskPush.toUser('satish', msg)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('every phone accepted: the tickets are kept to ask for their receipts later', async () => {
    fetchMock.mockResolvedValueOnce(reply({ data: [{ status: 'ok', id: 't1' }, { status: 'ok', id: 't2' }] }));
    expect(await taskPush.toUser('satish', msg)).toEqual({ devices: 2, accepted: 2, delivered: null, refused: [], ticketIds: ['t1', 't2'], checkedAt: null });
    expect(fetchMock.mock.calls[0][0]).toBe('https://exp.host/--/api/v2/push/send');
  });

  it('one phone refused: its reason is kept, and the phone token is never written anywhere', async () => {
    fetchMock.mockResolvedValueOnce(reply({ data: [
      { status: 'ok', id: 't1' },
      { status: 'error', message: `"${B}" is not a registered push notification recipient`, details: { error: 'DeviceNotRegistered' } },
    ] }));
    const out = await taskPush.toUser('satish', msg);
    expect(out).toEqual({ devices: 2, accepted: 1, delivered: null, refused: ['DeviceNotRegistered'], ticketIds: ['t1'], checkedAt: null });
    expect(JSON.stringify(out)).not.toContain('ExponentPushToken');
    expect(printed()).not.toContain('ExponentPushToken');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('DeviceNotRegistered'));
  });

  it('Expo turns the whole request down: nothing accepted, with its reason', async () => {
    fetchMock.mockResolvedValueOnce(reply({ errors: [{ code: 'PUSH_TOO_MANY_EXPERIENCE_IDS', message: 'x' }] }, 400));
    expect(await taskPush.toUser('satish', msg)).toMatchObject({ devices: 2, accepted: 0, refused: ['PUSH_TOO_MANY_EXPERIENCE_IDS'], ticketIds: [] });
  });

  it('Expo cannot be reached, or answers something unreadable: nothing accepted, and it says which', async () => {
    fetchMock.mockRejectedValueOnce(new Error('getaddrinfo ENOTFOUND exp.host'));
    expect(await taskPush.toUser('satish', msg)).toMatchObject({ accepted: 0, refused: ['SendFailed'], ticketIds: [] });
    fetchMock.mockResolvedValueOnce({ status: 502, ok: false, json: async () => { throw new Error('not json'); } } as unknown as Response);
    expect(await taskPush.toUser('satish', msg)).toMatchObject({ accepted: 0, refused: ['HTTP 502'], ticketIds: [] });
  });

  it('pushes switched off (dev / test): a dry run, nothing is sent and there is nothing to check later', async () => {
    pushEnabled = false;
    expect(await taskPush.toUser('satish', msg)).toEqual({ devices: 2, accepted: 2, delivered: null, refused: [], ticketIds: [], checkedAt: null });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith('[task-push] dry-run "Afshin assigned you a task" to 2 device(s) for satish');
  });
});

describe('the receipt check, about 15 minutes after a task push', () => {
  const NOW = new Date('2026-11-20T10:00:00.000Z');
  const ago = (min: number): Date => new Date(NOW.getTime() - min * 60_000);
  const row = (id: string, sentMinAgo: number, ticketIds: string[], refused: string[] = []): Row => ({
    _id: id, userId: 'satish', event: 'assigned', sentAt: ago(sentMinAgo),
    push: { devices: ticketIds.length + refused.length, accepted: ticketIds.length, delivered: null, refused, ticketIds, checkedAt: null },
  });

  it('asks nothing while no push is old enough to have a receipt', async () => {
    rows = [row('n1', 5, ['t1'])];
    expect(await taskPush.checkReceipts(NOW)).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('delivered to every phone: marked delivered and checked', async () => {
    rows = [row('n1', 20, ['t1', 't2'])];
    fetchMock.mockResolvedValueOnce(reply({ data: { t1: { status: 'ok' }, t2: { status: 'ok' } } }));
    expect(await taskPush.checkReceipts(NOW)).toBe(1);
    expect(fetchMock.mock.calls[0][0]).toBe('https://exp.host/--/api/v2/push/getReceipts');
    expect(JSON.parse(String(fetchMock.mock.calls[0][1].body))).toEqual({ ids: ['t1', 't2'] });
    expect(updates).toEqual([{ id: 'n1', set: { 'push.delivered': 2, 'push.refused': [], 'push.ticketIds': [], 'push.checkedAt': NOW } }]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('a phone that no longer has the app: counted as not delivered, with the reason, and it is logged', async () => {
    rows = [row('n1', 20, ['t1', 't2'])];
    fetchMock.mockResolvedValueOnce(reply({ data: {
      t1: { status: 'ok' },
      t2: { status: 'error', message: `"${B}" is not a registered push notification recipient`, details: { error: 'DeviceNotRegistered' } },
    } }));
    await taskPush.checkReceipts(NOW);
    expect(updates[0].set).toMatchObject({ 'push.delivered': 1, 'push.refused': ['DeviceNotRegistered'] });
    expect(warn).toHaveBeenCalledWith('[task-push] assigned to satish: delivered to 1 of 2 phone(s) — DeviceNotRegistered');
    expect(printed()).not.toContain('ExponentPushToken');
  });

  it('keeps a reason Expo gave at send time next to the receipt reasons', async () => {
    rows = [row('n1', 20, ['t1'], ['DeviceNotRegistered'])];
    fetchMock.mockResolvedValueOnce(reply({ data: { t1: { status: 'error', details: { error: 'MessageRateExceeded' } } } }));
    await taskPush.checkReceipts(NOW);
    expect(updates[0].set).toMatchObject({ 'push.delivered': 0, 'push.refused': ['DeviceNotRegistered', 'MessageRateExceeded'] });
  });

  it('a receipt that is not ready is asked for again next time; after an hour it is recorded as missing', async () => {
    rows = [row('young', 20, ['t1']), row('old', 61, ['t2'])];
    fetchMock.mockResolvedValueOnce(reply({ data: {} }));
    expect(await taskPush.checkReceipts(NOW)).toBe(1);
    expect(updates).toEqual([{ id: 'old', set: { 'push.delivered': 0, 'push.refused': ['NoReceipt'], 'push.ticketIds': [], 'push.checkedAt': NOW } }]);
  });

  it('Expo cannot be reached: nothing is marked, so the next round asks again', async () => {
    rows = [row('n1', 20, ['t1'])];
    fetchMock.mockRejectedValueOnce(new Error('timeout'));
    expect(await taskPush.checkReceipts(NOW)).toBe(0);
    expect(updates).toEqual([]);
  });

  it('does nothing when pushes are switched off', async () => {
    pushEnabled = false;
    rows = [row('n1', 20, ['t1'])];
    expect(await taskPush.checkReceipts(NOW)).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
