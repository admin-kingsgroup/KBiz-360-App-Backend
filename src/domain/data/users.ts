import type { PersonMeta, ReminderViewer, RoleKey, User } from '../types';

// Team & Users / "View as" identity space (a1…a9). Values copied from source adminUsers.
export const adminUsers: User[] = [
  { id: 'a1', name: 'Afshin Dhanani', initials: 'AD', color: '#0C0E14', role: 'SUPER_ADMIN',
    email: 'afshin@kbiz360.com', bizId: null, branches: [], accessGroups: [], accessDepts: [], accessAlerts: [],
    scopeLine: 'Everything · all businesses' },
  { id: 'a2', name: 'Farhan Aga', initials: 'FA', color: '#9A6CF0', role: 'DIRECTOR',
    email: 'farhan@travkings.com', bizId: 'tk', branches: ['AMD', 'BOM', 'NBO'],
    accessGroups: ['AMD-Accounts', 'BOM-Accounts', 'NBO-Accounts'],
    accessDepts: ['AMD-Accounts', 'AMD-Ticketing', 'BOM-Accounts', 'BOM-Ticketing', 'NBO-Accounts', 'NBO-Ticketing'],
    accessAlerts: ['AMD-crm', 'AMD-accounts', 'BOM-crm', 'BOM-accounts', 'NBO-crm', 'NBO-accounts'] },
  { id: 'a3', name: 'Pravesh', initials: 'PR', color: '#4F8BFF', role: 'GENERAL_MANAGER',
    email: 'pravesh@travkings.com', bizId: 'tk', branches: ['AMD', 'BOM'],
    accessGroups: ['AMD-Accounts', 'AMD-Ticketing', 'BOM-Accounts', 'BOM-Ticketing'],
    accessDepts: ['AMD-Accounts', 'AMD-Ticketing', 'BOM-Accounts', 'BOM-Ticketing'],
    accessAlerts: ['AMD-crm', 'AMD-accounts', 'AMD-pl', 'BOM-crm', 'BOM-accounts', 'BOM-pl'] },
  { id: 'a4', name: 'Faiz Patel', initials: 'FP', color: '#E8A13A', role: 'HOD',
    email: 'faiz@travkings.com', bizId: 'tk', branches: ['AMD', 'BOM', 'NBO'],
    accessGroups: ['AMD-Accounts', 'BOM-Accounts', 'NBO-Accounts'],
    accessDepts: ['AMD-Accounts', 'BOM-Accounts', 'NBO-Accounts'],
    accessAlerts: ['AMD-accounts', 'AMD-payables', 'BOM-accounts', 'BOM-payables', 'NBO-accounts', 'NBO-payables'] },
  { id: 'a5', name: 'Harshit', initials: 'HA', color: '#37B6A4', role: 'HOD',
    email: 'harshit@travkings.com', bizId: 'tk', branches: ['AMD'],
    accessGroups: ['AMD-Ticketing'], accessDepts: ['AMD-Ticketing'], accessAlerts: ['AMD-crm', 'AMD-accounts'] },
  { id: 'a6', name: 'Rohan', initials: 'RO', color: '#E3674E', role: 'EMPLOYEE',
    email: 'rohan@travkings.com', bizId: 'tk', branches: ['AMD'],
    accessGroups: ['AMD-Ticketing'], accessDepts: ['AMD-Ticketing'], accessAlerts: ['AMD-crm'] },
  { id: 'a7', name: 'Nandni', initials: 'NA', color: '#2FB36B', role: 'EMPLOYEE',
    email: 'nandni@travkings.com', bizId: 'tk', branches: ['AMD'],
    accessGroups: ['AMD-Accounts'], accessDepts: ['AMD-Accounts'], accessAlerts: ['AMD-accounts'] },
  { id: 'a8', name: 'Nurul', initials: 'NU', color: '#9A6CF0', role: 'EMPLOYEE',
    email: 'nurul@travkings.com', bizId: 'tk', branches: ['BOM'],
    accessGroups: ['BOM-Ticketing'], accessDepts: ['BOM-Ticketing'], accessAlerts: ['BOM-crm'] },
];

// SEPARATE reminder-visibility identity space (a, fa, p, …). Copied from source PERSON_META.
// NOTE: this is intentionally NOT unified with adminUsers — see foundation report §6.
export const PERSON_META: Record<string, PersonMeta> = {
  a:  { role: 'SUPER_ADMIN',     branches: ['AMD', 'BOM', 'NBO'], dept: null },
  fa: { role: 'DIRECTOR',        branches: ['AMD', 'BOM', 'NBO'], dept: null },
  p:  { role: 'GENERAL_MANAGER', branches: ['AMD', 'BOM'],        dept: null },
  f:  { role: 'BRANCH_MANAGER',  branches: ['AMD'],               dept: null },
  m:  { role: 'HOD',             branches: ['AMD'],               dept: 'Accounts' },
  r:  { role: 'EMPLOYEE',        branches: ['AMD'],               dept: 'Ticketing' },
  sn: { role: 'EMPLOYEE',        branches: ['BOM'],               dept: 'Accounts' },
  ko: { role: 'EMPLOYEE',        branches: ['NBO'],               dept: 'Holidays' },
  an: { role: 'EMPLOYEE',        branches: ['BOM'],               dept: 'MKTG' },
};

// Representative reminder viewer per role ("View as" in Reminders). Copied from ROLE_VIEWERS.
export const ROLE_VIEWERS: Record<RoleKey, ReminderViewer> = {
  SUPER_ADMIN:     { id: 'a',  role: 'SUPER_ADMIN',     branches: ['AMD', 'BOM', 'NBO'], dept: null },
  DIRECTOR:        { id: 'fa', role: 'DIRECTOR',        branches: ['AMD', 'BOM', 'NBO'], dept: null },
  GENERAL_MANAGER: { id: 'p',  role: 'GENERAL_MANAGER', branches: ['AMD', 'BOM'],        dept: null },
  BRANCH_MANAGER:  { id: 'f',  role: 'BRANCH_MANAGER',  branches: ['AMD'],               dept: null },
  HOD:             { id: 'm',  role: 'HOD',             branches: ['AMD'],               dept: 'Accounts' },
  EMPLOYEE:        { id: 'r',  role: 'EMPLOYEE',        branches: ['AMD'],               dept: 'Ticketing' },
};
