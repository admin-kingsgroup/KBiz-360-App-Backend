import { crmRepo } from '../crm.repo';
import type { TaskDepartment } from './task.types';

// Owner, 2026-11-20: "when we create task in operation then harshit, asif, and farhan should automatically
// added in watcher if the task is not assigned or for them", and then "same like if task is of accounts then
// add faiz, farhan and afshin". Every task of a department is watched by the people named for it here.
// The task service leaves out whoever gave the task or is doing it — they are on it already.
//
// Named people, by login email, like the chat group rules (chat.service GROUP_*_EMAILS). To change who
// watches a department's tasks, edit this list.
export const DEPARTMENT_WATCHER_EMAILS: Partial<Record<TaskDepartment, readonly string[]>> = {
  operations: ['harshit@travkings.com', 'asif@travkings.com', 'farhan@travkings.com'],
  accounts: ['faiz@travkings.com', 'farhan@travkings.com', 'afshin.dhanani@kingsgroupco.com'],
};

/**
 * The accounts that watch every task of this department, in the order they are named. An email with no
 * active account is left out. Never throws: if the lookup fails nobody is added and the task stands.
 */
export async function departmentWatcherIds(department: TaskDepartment | null | undefined): Promise<string[]> {
  const emails = department ? DEPARTMENT_WATCHER_EMAILS[department] ?? [] : [];
  if (!emails.length) return [];
  try {
    const users = await crmRepo.listUsers({ email: { $in: [...emails] } });
    const active = users.filter((u) => !u.status || u.status === 'active');
    return emails
      .map((email) => active.find((u) => (u.email ?? '').toLowerCase() === email))
      .filter((u): u is NonNullable<typeof u> => !!u)
      .map((u) => String(u._id));
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(`[task-watchers] ${department} watchers not looked up: ${(e as Error).message}`);
    return [];
  }
}
