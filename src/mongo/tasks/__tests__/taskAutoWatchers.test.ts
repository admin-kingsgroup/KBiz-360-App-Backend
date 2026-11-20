// Owner, 2026-11-20: every Operations task is watched by Harshit, Asif and Farhan. This file checks the
// lookup of those three accounts; what the task service does with them is in taskService.test.ts.
let users: Array<{ _id: string; email: string; status?: string }> = [];
let lookupError: string | null = null;
const filters: Array<Record<string, unknown>> = [];

jest.mock('../../crm.repo', () => ({
  crmRepo: {
    listUsers: async (filter: { email?: { $in?: string[] } } = {}) => {
      filters.push(filter);
      if (lookupError) throw new Error(lookupError);
      const wanted = filter.email?.$in ?? [];
      return users.filter((u) => wanted.includes(u.email));
    },
  },
}));

import { DEPARTMENT_WATCHER_EMAILS, departmentWatcherIds } from '../task.autoWatchers';

beforeEach(() => {
  lookupError = null;
  filters.length = 0;
  users = [
    { _id: 'u-farhan', email: 'farhan@travkings.com', status: 'active' },
    { _id: 'u-satish', email: 'satish@travkings.com', status: 'active' },
    { _id: 'u-asif', email: 'asif@travkings.com' }, // no status = active, as the people list reads it
    { _id: 'u-harshit', email: 'harshit@travkings.com', status: 'active' },
  ];
});

describe('the people who watch every task of a department', () => {
  it('Operations: Harshit, Asif and Farhan, by their login emails', () => {
    expect(DEPARTMENT_WATCHER_EMAILS.operations).toEqual(['harshit@travkings.com', 'asif@travkings.com', 'farhan@travkings.com']);
    expect(DEPARTMENT_WATCHER_EMAILS.accounts).toBeUndefined();
  });

  it('resolves them to their accounts, in the order they are named', async () => {
    expect(await departmentWatcherIds('operations')).toEqual(['u-harshit', 'u-asif', 'u-farhan']);
    expect(filters).toEqual([{ email: { $in: ['harshit@travkings.com', 'asif@travkings.com', 'farhan@travkings.com'] } }]);
  });

  it('nobody for Accounts or for a task with no department — and no lookup is made', async () => {
    expect(await departmentWatcherIds('accounts')).toEqual([]);
    expect(await departmentWatcherIds(null)).toEqual([]);
    expect(await departmentWatcherIds(undefined)).toEqual([]);
    expect(filters).toEqual([]);
  });

  it('leaves out someone whose account is switched off or does not exist', async () => {
    users = users.filter((u) => u._id !== 'u-asif').map((u) => (u._id === 'u-farhan' ? { ...u, status: 'inactive' } : u));
    expect(await departmentWatcherIds('operations')).toEqual(['u-harshit']);
  });

  it('a failed lookup adds nobody — the task is still created', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    lookupError = 'mongo is down';
    expect(await departmentWatcherIds('operations')).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('mongo is down'));
    warn.mockRestore();
  });
});
