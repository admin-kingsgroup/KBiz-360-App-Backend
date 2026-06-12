import type { RoleKey } from './roles';

// Branch-qualified grant id, e.g. 'AMD-Accounts' (group/dept) or 'AMD-crm' (alert).
export type GrantId = string;

export interface User {
  id: string;
  name: string;
  initials: string;
  color: string;
  role: RoleKey;
  email?: string;
  bizId: string | null;
  branches: string[];          // branch codes
  accessGroups: GrantId[];
  accessDepts: GrantId[];
  accessAlerts: GrantId[];
  attendance?: boolean;
  scopeLine?: string;
  login?: string;
}

// Reminder-visibility identity (separate id space in the current app — see foundation report).
export interface PersonMeta {
  role: RoleKey;
  branches: string[];
  dept: string | null;
}

export interface ReminderViewer extends PersonMeta {
  id: string;
}
