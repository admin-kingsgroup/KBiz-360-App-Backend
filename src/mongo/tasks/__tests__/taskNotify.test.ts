// No DB, no network. Who gets told, and on which channel (spec §6, owner's answers 2026-11-16).
import { Types } from 'mongoose';

const pushed: Array<{ to: string; title: string }> = [];
const mailed: Array<{ to: string; subject: string }> = [];
const logged: Array<{ userId: string; channels: string[]; push?: Record<string, unknown> | null }> = [];
let smtp = true;

jest.mock('../../calls/call.repository', () => ({
  callDeviceRepo: { tokensForUser: async (id: string) => [`ExponentPushToken[${id}]`] },
}));
jest.mock('../../../config', () => ({ config: { push: { enabled: false } } }));
jest.mock('../../../mailer', () => ({
  mailer: { send: async (m: { to: string; subject: string }) => { if (!smtp) return false; mailed.push(m); return true; } },
}));
jest.mock('../../chat/chat.events', () => ({ emitToUser: () => undefined }));
jest.mock('../task.model', () => ({
  TaskNotificationModel: () => ({ create: async (d: { userId: string; channels: string[]; push?: Record<string, unknown> | null }) => { logged.push(d); } }),
}));
jest.mock('../task.people', () => ({
  taskPeople: {
    resolve: async (ids: string[]) => new Map(ids.map((id) => [id, { id, name: id === 'afshin' ? 'Afshin Dhanani' : id, email: `${id}@test`, level: 5, branchIds: [], tz: 'Asia/Kolkata' }])),
  },
  unknownPerson: (id: string) => ({ id, name: 'Unknown', email: '', level: 5, branchIds: [], tz: 'Asia/Kolkata' }),
}));

// Capture pushes from the dry-run log line rather than the network.
const logSpy = jest.spyOn(console, 'log').mockImplementation((line: string) => {
  const m = /^\[task-push\] dry-run "(.+)" to \d+ device\(s\) for (\S+)$/.exec(String(line));
  if (m) pushed.push({ title: m[1], to: m[2] });
});

import { taskNotify } from '../task.notify';
import { taskPush } from '../task.push';
import type { TaskDoc } from '../task.model';

const task = (over: Partial<TaskDoc> = {}): TaskDoc => ({
  _id: new Types.ObjectId(), title: 'Close October books', priority: 'normal', dueAt: new Date('2026-11-20T12:30:00.000Z'),
  requestedDueAt: null, chatId: 'c1', ...over,
} as TaskDoc);

const at = (iso: string): void => { jest.setSystemTime(new Date(iso)); };

beforeAll(() => { jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] }); });
afterAll(() => { jest.useRealTimers(); logSpy.mockRestore(); });
beforeEach(() => { pushed.length = 0; mailed.length = 0; logged.length = 0; smtp = true; });

describe('task notifications', () => {
  it('never tells the actor about their own action, and de-dupes', async () => {
    at('2026-11-18T06:00:00.000Z'); // 11:30 IST
    await taskNotify.send('closed', task(), ['afshin', 'satish', 'satish'], { actorId: 'afshin' });
    expect(pushed.map((p) => p.to)).toEqual(['satish']);
    expect(pushed[0].title).toBe('Afshin Dhanani closed a task');
    expect(mailed.map((m) => m.to)).toEqual(['satish@test']);
  });

  it('quiet hours: no push for a Normal task, but the email still goes', async () => {
    at('2026-11-18T17:30:00.000Z'); // 23:00 IST
    await taskNotify.send('assigned', task(), ['satish'], { actorId: 'afshin' });
    expect(pushed).toEqual([]);
    expect(mailed).toHaveLength(1);
    expect(logged[0].channels).toEqual(['inapp', 'email']);
  });

  it('quiet hours: an Urgent task still pushes', async () => {
    at('2026-11-18T17:30:00.000Z');
    await taskNotify.send('overdue', task({ priority: 'urgent' }), ['satish', 'afshin'], {});
    expect(pushed.map((p) => p.to).sort()).toEqual(['afshin', 'satish']);
    expect(pushed[0].title).toBe('⚠️ Task overdue');
  });

  it('works without SMTP (email dormant) — in-app + push only', async () => {
    smtp = false;
    at('2026-11-18T06:00:00.000Z');
    await taskNotify.send('accepted', task(), ['afshin'], { actorId: 'satish' });
    expect(mailed).toEqual([]);
    expect(logged[0].channels).toEqual(['inapp', 'push']);
  });
});

// Owner, 2026-11-20: keep what Expo answered, so a push that did not go through leaves a trace.
describe('what Expo said about the push is kept on the notification', () => {
  it('a push that went out carries Expo\'s answer', async () => {
    at('2026-11-18T06:00:00.000Z');
    await taskNotify.send('assigned', task(), ['satish'], { actorId: 'afshin' });
    expect(logged[0].channels).toEqual(['inapp', 'push', 'email']);
    expect(logged[0].push).toEqual({ devices: 1, accepted: 1, delivered: null, refused: [], ticketIds: [], checkedAt: null });
  });

  it('a push Expo refused on every phone is not counted as pushed, and says why', async () => {
    at('2026-11-18T06:00:00.000Z');
    const refused = { devices: 2, accepted: 0, delivered: null, refused: ['DeviceNotRegistered'], ticketIds: [], checkedAt: null };
    const spy = jest.spyOn(taskPush, 'toUser').mockResolvedValueOnce(refused);
    await taskNotify.send('assigned', task(), ['satish'], { actorId: 'afshin' });
    expect(logged[0].channels).toEqual(['inapp', 'email']);
    expect(logged[0].push).toEqual(refused);
    spy.mockRestore();
  });

  it('no push was tried (quiet hours, or no phone registered): nothing to keep', async () => {
    at('2026-11-18T17:30:00.000Z'); // 23:00 IST
    await taskNotify.send('assigned', task(), ['satish'], { actorId: 'afshin' });
    expect(logged[0].push).toBeNull();
    at('2026-11-18T06:00:00.000Z');
    const spy = jest.spyOn(taskPush, 'toUser').mockResolvedValueOnce(null);
    await taskNotify.send('assigned', task(), ['faiz'], { actorId: 'afshin' });
    expect(logged[1].channels).toEqual(['inapp', 'email']);
    expect(logged[1].push).toBeNull();
    spy.mockRestore();
  });
});
