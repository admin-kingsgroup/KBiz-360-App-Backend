// No DB: an in-memory task store stands in for Mongo. The task service end to end — chat, history,
// notifications, visibility (spec 2026-11-16 + the owner's answers the same day).
import { Types } from 'mongoose';
import type { TaskDoc } from '../task.model';

const tasks: TaskDoc[] = [];
const history: Array<Record<string, unknown>> = [];
const notices: Array<{ chatId: string; text: string }> = [];
const chatMembers = new Map<string, string[]>();
const sent: Array<{ event: string; to: string[]; actorId?: string | null }> = [];
const chatState: Array<[string, 'closed' | 'reopened']> = [];

// structuredClone drops the ObjectId class (String(_id) would read "[object Object]") — put it back.
const clone = (t: TaskDoc): TaskDoc => ({ ...structuredClone(t), _id: t._id });
const getPath = (o: Record<string, unknown>, path: string): unknown => path.split('.').reduce<unknown>((v, k) => (v as Record<string, unknown> | undefined)?.[k], o);
const setPath = (o: Record<string, unknown>, path: string, value: unknown): void => {
  const keys = path.split('.');
  let cur = o;
  for (const k of keys.slice(0, -1)) cur = (cur[k] ??= {}) as Record<string, unknown>;
  cur[keys[keys.length - 1]] = value;
};

jest.mock('../task.repository', () => ({
  taskRepo: {
    create: async (doc: Partial<TaskDoc>) => {
      const t = {
        _id: new Types.ObjectId(), description: '', watchers: [], attachments: [], repeat: { kind: 'none' }, chatId: null, link: null,
        requestedDueAt: null, waitingOn: null, parentRecurringId: null, nextSpawnedAt: null, acceptedAt: null, doneAt: null, closedAt: null,
        cancelledAt: null, alerts: { dueTomorrowAt: null, due2hAt: null, overdueAt: null, acceptNudgeAt: null }, createdAt: new Date(), updatedAt: new Date(),
        ...doc,
      } as TaskDoc;
      tasks.push(t);
      return { ...t };
    },
    byId: async (id: string) => { const t = tasks.find((x) => String(x._id) === id); return t ? clone(t) : null; },
    update: async (id: string, update: Record<string, unknown>, filter: Record<string, unknown> = {}) => {
      const t = tasks.find((x) => String(x._id) === id) as unknown as Record<string, unknown> | undefined;
      if (!t) return null;
      if (Object.entries(filter).some(([k, v]) => getPath(t, k) !== v)) return null;
      const ops = Object.keys(update).some((k) => k.startsWith('$')) ? update : { $set: update };
      for (const [k, v] of Object.entries((ops.$set ?? {}) as Record<string, unknown>)) setPath(t, k, v);
      for (const [k, v] of Object.entries((ops.$push ?? {}) as Record<string, unknown>)) (t[k] as unknown[]).push(v);
      return clone(t as unknown as TaskDoc);
    },
    find: async () => tasks.map((t) => clone(t)),
    addHistory: async (rows: Array<Record<string, unknown>>) => { history.push(...rows); },
    history: async (taskId: string) => history.filter((h) => h.taskId === taskId).map((h, i) => ({ _id: new Types.ObjectId(), createdAt: new Date(1_800_000_000_000 + i), ...h })),
  },
}));

// People: afshin = Super Admin (level 1), farhan = branch manager at BOM (3), satish / faiz = staff at BOM (5),
// nbo = staff in Nairobi (5).
const BOM = new Types.ObjectId().toHexString();
const NBO = new Types.ObjectId().toHexString();
const PEOPLE: Record<string, { level: number; branchIds: string[]; tz: string; name: string }> = {
  afshin: { level: 1, branchIds: [BOM], tz: 'Asia/Kolkata', name: 'Afshin Dhanani' },
  farhan: { level: 3, branchIds: [BOM], tz: 'Asia/Kolkata', name: 'Farhan' },
  satish: { level: 5, branchIds: [BOM], tz: 'Asia/Kolkata', name: 'Satish' },
  faiz: { level: 5, branchIds: [BOM], tz: 'Asia/Kolkata', name: 'Faiz' },
  nbo: { level: 5, branchIds: [NBO], tz: 'Africa/Nairobi', name: 'Wanjiru' },
};
jest.mock('../task.people', () => ({
  taskPeople: {
    resolve: async (ids: string[]) => new Map(ids.filter((id) => id in PEOPLE).map((id) => [id, { id, email: `${id}@test`, ...PEOPLE[id] }])),
    one: async (id: string) => (id in PEOPLE ? { id, email: `${id}@test`, ...PEOPLE[id] } : null),
  },
  unknownPerson: (id: string) => ({ id, name: 'Unknown', email: '', level: 5, branchIds: [], tz: 'Asia/Kolkata' }),
}));
jest.mock('../../access', () => {
  const canSee = (viewer: { level: number; companyWide: boolean; branchIds: string[] | null }, target: { level: number; branchIds: string[] }): boolean => {
    if (target.level <= viewer.level) return false;
    if (viewer.companyWide) return true;
    return target.branchIds.some((b) => (viewer.branchIds ?? []).includes(b));
  };
  return {
    accessService: {
      accessForUserId: async (id: string) => (id in PEOPLE ? { userId: id, level: PEOPLE[id].level, isSuper: PEOPLE[id].level === 1, companyWide: PEOPLE[id].level <= 2, branchIds: PEOPLE[id].level <= 2 ? null : PEOPLE[id].branchIds } : null),
      canSee,
    },
  };
});
jest.mock('../../crm.repo', () => ({
  crmRepo: {
    branchesByIds: async (ids: Types.ObjectId[]) => ids.map((id) => ({ _id: id, name: String(id) === BOM ? 'BOM' : 'NBO', code: String(id) === BOM ? 'BOM' : 'NBO', company_id: new Types.ObjectId('64b000000000000000000001') })),
    listCompanies: async () => [{ _id: new Types.ObjectId('64b000000000000000000001'), name: 'Travkings' }],
    listUsers: async () => Object.keys(PEOPLE).map((id) => ({ _id: id })),
  },
}));
jest.mock('../../chat/chat.service', () => ({
  chatService: {
    createTaskChat: async (_actor: string, input: { memberIds: string[]; notice: string }) => {
      const id = new Types.ObjectId().toHexString();
      chatMembers.set(id, input.memberIds);
      notices.push({ chatId: id, text: input.notice });
      return id;
    },
    setTaskChatMembers: async (chatId: string, ids: string[]) => { chatMembers.set(chatId, ids); },
    renameTaskChat: async () => undefined,
    postTaskNotice: async (chatId: string, _a: string, text: string) => { notices.push({ chatId, text }); },
    readTaskMessages: async () => [{ id: 'm1', text: 'hello' }],
    closeTaskChat: async (chatId: string) => { chatState.push([chatId, 'closed']); },
    reopenTaskChat: async (chatId: string) => { chatState.push([chatId, 'reopened']); },
    unreadFor: async () => ({}),
  },
}));
jest.mock('../../chat/chat.events', () => ({ emitToUsers: () => undefined }));
jest.mock('../task.notify', () => ({
  taskNotify: { send: async (event: string, _t: unknown, to: string[], ctx: { actorId?: string | null }) => { sent.push({ event, to: to.filter((x) => x !== ctx.actorId), actorId: ctx.actorId }); } },
}));

import { tasksService } from '../task.service';

const NOW = new Date('2026-11-18T06:00:00.000Z'); // 11:30 IST, Wednesday
const base = { title: 'Close October books', branchId: BOM, priority: 'normal' as const, dueDate: '2026-11-20' };

beforeEach(() => { tasks.length = 0; history.length = 0; notices.length = 0; chatMembers.clear(); sent.length = 0; chatState.length = 0; });

// Create a task and start its chat (owner 2026-11-16 evening: no task comes with a chat).
async function withChat(actor: string, input: Parameters<typeof tasksService.create>[1], starter = actor) {
  const t = await tasksService.create(actor, input, { now: NOW });
  const { chatId } = await tasksService.ensureChat(starter, t.id);
  return { ...t, chatId };
}

describe('creating a task', () => {
  it('has no chat yet, defaults the time to 6 pm in the assignee’s zone, and tells the assignee', async () => {
    const t = await tasksService.create('afshin', { ...base, assignedTo: 'satish', watcherIds: ['faiz'] }, { now: NOW });
    expect(t.status).toBe('assigned');
    expect(t.dueAt).toBe('2026-11-20T12:30:00.000Z');
    expect(t.chatId).toBeNull();
    expect(notices).toEqual([]);
    expect(sent).toContainEqual({ event: 'assigned', to: ['satish'], actorId: 'afshin' });
    expect(sent).toContainEqual({ event: 'watcher_added', to: ['faiz'], actorId: 'afshin' });
    expect(history[0]).toMatchObject({ field: 'created', userId: 'afshin' });
  });

  it('6 pm in Nairobi for a Nairobi assignee', async () => {
    const t = await tasksService.create('afshin', { ...base, branchId: NBO, assignedTo: 'nbo' }, { now: NOW });
    expect(t.dueAt).toBe('2026-11-20T15:00:00.000Z');
  });

  it('a task for yourself starts Accepted and needs no acceptance', async () => {
    const t = await tasksService.create('satish', { ...base, assignedTo: 'satish' }, { now: NOW });
    expect(t.status).toBe('accepted');
    expect(t.isSelf).toBe(true);
    expect(sent.find((s) => s.event === 'assigned')?.to).toEqual([]); // nobody else to tell
  });

  it('refuses a due date in the past, a long title, and a missing due date', async () => {
    await expect(tasksService.create('afshin', { ...base, assignedTo: 'satish', dueDate: '2026-11-17' }, { now: NOW })).rejects.toThrow(/past/);
    await expect(tasksService.create('afshin', { ...base, assignedTo: 'satish', title: 'x'.repeat(121) }, { now: NOW })).rejects.toThrow(/120/);
    await expect(tasksService.create('afshin', { ...base, assignedTo: 'satish', dueDate: undefined }, { now: NOW })).rejects.toThrow(/due date is required/);
  });
});

describe('Start chat (giver or assignee only, while open)', () => {
  it('the assignee starts it; giver, assignee and watchers are members', async () => {
    const t = await tasksService.create('afshin', { ...base, assignedTo: 'satish', watcherIds: ['faiz'] }, { now: NOW });
    const { chatId } = await tasksService.ensureChat('satish', t.id);
    expect(chatMembers.get(chatId)).toEqual(['afshin', 'satish', 'faiz']);
    expect(notices[0].text).toBe('Satish started a chat about this task · Assigned · due 20 Nov, 6:00 pm');
    expect((await tasksService.ensureChat('faiz', t.id)).chatId).toBe(chatId); // a watcher opens the existing one
    expect((await tasksService.ensureChat('afshin', t.id)).chatId).toBe(chatId); // never a second chat
  });
  it('a watcher or a manager cannot start it', async () => {
    const t = await tasksService.create('afshin', { ...base, assignedTo: 'satish', watcherIds: ['faiz'] }, { now: NOW });
    await expect(tasksService.ensureChat('faiz', t.id)).rejects.toThrow('Only Afshin Dhanani or Satish can start this task\'s chat');
    await expect(tasksService.ensureChat('farhan', t.id)).rejects.toThrow(/can start/);
  });
  it('not on a closed task', async () => {
    const t = await tasksService.create('satish', { ...base, assignedTo: 'satish' }, { now: NOW });
    await tasksService.changeStatus('satish', t.id, { to: 'done' }, NOW);
    await expect(tasksService.ensureChat('satish', t.id)).rejects.toThrow(/closed/);
  });
});

describe('who sees a task', () => {
  it('the people on it, a manager above the assignee in the branch, and the Super Admin — not other staff', async () => {
    const t = await tasksService.create('satish', { ...base, assignedTo: 'satish' }, { now: NOW });
    expect((await tasksService.get('farhan', t.id)).task.myRole).toBe('viewer');
    expect((await tasksService.get('farhan', t.id)).task.actions).toEqual([]);
    expect((await tasksService.get('afshin', t.id)).task.myRole).toBe('viewer');
    await expect(tasksService.get('faiz', t.id)).rejects.toThrow(/not found/i);
    await expect(tasksService.get('nbo', t.id)).rejects.toThrow(/not found/i);
  });

  it('a manager reads the chat without being a member', async () => {
    const t = await withChat('afshin', { ...base, assignedTo: 'satish' });
    expect(chatMembers.get(t.chatId as string)).not.toContain('farhan');
    expect(await tasksService.messages('farhan', t.id, {})).toEqual([{ id: 'm1', text: 'hello' }]);
    await expect(tasksService.messages('faiz', t.id, {})).rejects.toThrow(/not found/i);
  });
});

describe('status changes', () => {
  it('post a chat line and a history row, and tell the other side', async () => {
    const t = await withChat('afshin', { ...base, assignedTo: 'satish' });
    await tasksService.changeStatus('satish', t.id, { to: 'accepted' }, NOW);
    await tasksService.changeStatus('satish', t.id, { to: 'in_progress' }, NOW);
    const done = await tasksService.changeStatus('satish', t.id, { to: 'done' }, new Date('2026-11-18T10:42:00.000Z'));
    expect(done.status).toBe('done');
    expect(notices.at(-1)?.text).toBe('Satish marked this Done – to close · 18 Nov, 4:12 pm');
    expect(sent.at(-1)).toEqual({ event: 'done', to: ['afshin'], actorId: 'satish' });
    expect(history.filter((h) => h.field === 'status').map((h) => h.newValue)).toEqual(['accepted', 'in_progress', 'done']);
    await expect(tasksService.changeStatus('satish', t.id, { to: 'closed' }, NOW)).rejects.toThrow(/Only the person who assigned/);
    const closed = await tasksService.changeStatus('afshin', t.id, { to: 'closed' }, new Date('2026-11-20T06:00:00.000Z'));
    expect(closed.status).toBe('closed');
    expect(notices.at(-1)?.text).toBe('Task closed by Afshin Dhanani on 20 Nov 2026.');
    expect(chatState).toEqual([[t.chatId, 'closed']]); // off every list, read-only — the closing line posted first
  });

  it('Done – to close keeps the chat open; Reopened brings a closed chat back; Cancelled closes it', async () => {
    const t = await withChat('afshin', { ...base, assignedTo: 'satish' });
    for (const to of ['accepted', 'in_progress', 'done'] as const) await tasksService.changeStatus('satish', t.id, { to }, NOW);
    expect(chatState).toEqual([]);
    await tasksService.changeStatus('afshin', t.id, { to: 'closed' }, NOW);
    await tasksService.changeStatus('afshin', t.id, { to: 'reopened', comment: 'Bank charges missing' }, NOW);
    expect(chatState).toEqual([[t.chatId, 'closed'], [t.chatId, 'reopened']]);
    expect(notices.at(-1)?.text).toMatch(/^Afshin Dhanani marked this Reopened — Bank charges missing/);
    await tasksService.changeStatus('satish', t.id, { to: 'in_progress' }, NOW);
    await tasksService.changeStatus('afshin', t.id, { to: 'cancelled', comment: 'No longer needed' }, NOW);
    expect(chatState.at(-1)).toEqual([t.chatId, 'closed']);
  });

  it('a date change request, then the assigner approves it', async () => {
    const t = await tasksService.create('afshin', { ...base, assignedTo: 'satish' }, { now: NOW });
    await tasksService.changeStatus('satish', t.id, { to: 'date_change_requested', comment: 'Bank statement only on 22nd', dueDate: '2026-11-23' }, NOW);
    expect(sent.at(-1)?.event).toBe('date_change_requested');
    const ok = await tasksService.changeStatus('afshin', t.id, { to: 'accepted' }, NOW);
    expect(ok.dueAt).toBe('2026-11-23T12:30:00.000Z');
    expect(sent.at(-1)).toEqual({ event: 'due_changed', to: ['satish'], actorId: 'afshin' });
  });

  it('closing a repeating task creates the next copy', async () => {
    const t = await tasksService.create('afshin', { ...base, assignedTo: 'satish', repeat: { kind: 'weekly', days: [5] } }, { now: NOW });
    for (const to of ['accepted', 'in_progress', 'done'] as const) await tasksService.changeStatus('satish', t.id, { to }, NOW);
    await tasksService.changeStatus('afshin', t.id, { to: 'closed' }, NOW);
    expect(tasks).toHaveLength(2);
    expect(tasks[1].dueAt?.toISOString()).toBe('2026-11-27T12:30:00.000Z'); // next Friday, 6 pm IST
    expect(tasks[1].parentRecurringId).toBe(t.id);
    expect(tasks[1].status).toBe('assigned');
    await tasksService.spawnNext(tasks[0], NOW); // already spawned — claimed once
    expect(tasks).toHaveLength(2);
  });
});

describe('editing and reassigning', () => {
  it('only the assigner edits', async () => {
    const t = await tasksService.create('afshin', { ...base, assignedTo: 'satish' }, { now: NOW });
    await expect(tasksService.patch('satish', t.id, { title: 'mine now' }, NOW)).rejects.toThrow(/Only the person who assigned/);
  });

  it('editing dueAt clears alert stamps', async () => {
    const t = await tasksService.create('afshin', { ...base, assignedTo: 'satish' }, { now: NOW });
    tasks[0].alerts = { dueTomorrowAt: NOW, due2hAt: NOW, overdueAt: NOW, acceptNudgeAt: NOW };
    const out = await tasksService.patch('afshin', t.id, { dueDate: '2026-11-25', dueTime: '11:00' }, NOW);
    expect(out.dueAt).toBe('2026-11-25T05:30:00.000Z');
    expect(tasks[0].alerts).toMatchObject({ dueTomorrowAt: null, due2hAt: null, overdueAt: null });
    expect(sent.at(-1)).toEqual({ event: 'due_changed', to: ['satish'], actorId: 'afshin' });
    expect(history.at(-1)).toMatchObject({ field: 'dueAt', newValue: '2026-11-25T05:30:00.000Z' });
  });

  it('reassign to self', async () => {
    const t = await withChat('afshin', { ...base, assignedTo: 'satish' });
    const out = await tasksService.reassign('afshin', t.id, { assignedTo: 'afshin' }, NOW);
    expect(out.status).toBe('accepted');
    expect(out.isSelf).toBe(true);
    expect(chatMembers.get(t.chatId as string)).toEqual(['afshin']); // Satish leaves the chat
    expect(sent.at(-1)).toEqual({ event: 'reassigned_away', to: ['satish'], actorId: 'afshin' });
  });

  it('reassigning keeps a watcher in the chat and resets to Assigned', async () => {
    const t = await withChat('afshin', { ...base, assignedTo: 'satish', watcherIds: ['faiz'] });
    await tasksService.changeStatus('satish', t.id, { to: 'accepted' }, NOW);
    const out = await tasksService.reassign('afshin', t.id, { assignedTo: 'faiz', comment: 'Satish on leave' }, NOW);
    expect(out.status).toBe('assigned');
    expect(out.watchers).toEqual([]); // Faiz is the assignee now, not a watcher
    expect(chatMembers.get(t.chatId as string)).toEqual(['afshin', 'faiz']);
  });
});

describe('watchers', () => {
  it('a manager who can see the task may watch it, but not add others', async () => {
    const t = await withChat('afshin', { ...base, assignedTo: 'satish' });
    await expect(tasksService.watchers('farhan', t.id, { add: ['faiz'] }, NOW)).rejects.toThrow(/yourself/);
    const out = await tasksService.watchers('farhan', t.id, { add: ['farhan'] }, NOW);
    expect(out.myRole).toBe('watcher');
    expect(chatMembers.get(t.chatId as string)).toContain('farhan');
    expect(notices.at(-1)?.text).toBe('Farhan is now watching this task');
  });
});
