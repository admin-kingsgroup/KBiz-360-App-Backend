import type { RoleDef, RoleKey } from '../types';

// Order = hierarchy (used for pickers and reminder role-tier grouping).
export const ROLE_OPTIONS: RoleKey[] = [
  'SUPER_ADMIN', 'DIRECTOR', 'GENERAL_MANAGER', 'BRANCH_MANAGER', 'HOD', 'EMPLOYEE',
];

// Values copied verbatim from source ROLE_DEFS. `color` values are the resolved
// hex from the theme object C (ink/purple/blue/teal/orange/textMuted2). Icon excluded.
export const ROLE_DEFS: Record<RoleKey, RoleDef> = {
  SUPER_ADMIN: {
    key: 'SUPER_ADMIN', label: 'Super Admin', badge: 'SUPER ADMIN', color: '#0C0E14',
    scope: 'Everything · all businesses & branches',
    sees: 'Sees ALL team reminders (name-wise)',
    perms: ['Create / edit any business', 'Add / remove any user', "Set anyone's role & access", 'Full read & write everywhere', 'App settings, branding & audit log'],
  },
  DIRECTOR: {
    key: 'DIRECTOR', label: 'Director', badge: 'DIRECTOR', color: '#9A6CF0',
    scope: 'Assigned business · selected branches, groups, departments & alerts',
    sees: 'Sees GM, Branch Mgr, HOD & staff — business-wide',
    perms: ['Oversees assigned business(es)', 'Selected branches & departments', 'Set reminders down the chain', 'Invite GM / Branch Manager / HOD', 'Access only what is granted'],
  },
  GENERAL_MANAGER: {
    key: 'GENERAL_MANAGER', label: 'General Manager', badge: 'GM', color: '#4F8BFF',
    scope: 'Operations · selected branches, groups, departments & alerts',
    sees: 'Sees Branch Mgr, HOD & staff — their branches',
    perms: ['Runs day-to-day operations', 'Selected branches & departments', 'Manage Branch Managers & HODs', 'Set reminders down the chain', 'Access only what is granted'],
  },
  BRANCH_MANAGER: {
    key: 'BRANCH_MANAGER', label: 'Branch Manager', badge: 'BRANCH MGR', color: '#37B6A4',
    scope: 'Selected branches · their groups, departments & alerts',
    sees: 'Sees HOD & staff — their branch',
    perms: ['Manages selected branch(es)', 'All granted groups & departments', 'Manage HODs & staff in scope', 'Set reminders for the branch', 'Cannot see other branches'],
  },
  HOD: {
    key: 'HOD', label: 'HOD', badge: 'HOD', color: '#E8A13A',
    scope: 'Head of Department · selected groups, departments & alerts',
    sees: 'Sees staff — their department',
    perms: ['Heads a department', 'Granted groups & department alerts', 'Manage staff in the department', 'Set reminders for the department', 'Access only what is granted'],
  },
  EMPLOYEE: {
    key: 'EMPLOYEE', label: 'Employee', badge: 'EMPLOYEE', color: '#6D6D72',
    scope: 'Own groups, department & alerts only',
    sees: 'Sees only their own reminders',
    perms: ['Access granted groups only', 'Read / write in scope', '1:1 chats with anyone in scope', 'Set reminders for self & teammates', 'Cannot manage anything'],
  },
};

// Reminder-visibility ranking (lower = higher authority). Copied verbatim.
export const RANK: Record<RoleKey, number> = {
  SUPER_ADMIN: 0, DIRECTOR: 1, GENERAL_MANAGER: 2, BRANCH_MANAGER: 3, HOD: 4, EMPLOYEE: 5,
};
