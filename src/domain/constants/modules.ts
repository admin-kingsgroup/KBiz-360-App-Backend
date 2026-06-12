import type { ModuleDef, ModuleKey } from '../types';

export const MODULES: ModuleDef[] = [
  { key: 'crm',         name: 'CRM',         icon: '🎯', color: '#4F8BFF', tint: '#E4EDFF', description: 'Leads, conversions & customers' },
  { key: 'accounts',    name: 'Accounts',    icon: '📒', color: '#E8A13A', tint: '#FBEBD2', description: 'Ledger, journals & reconciliation' },
  { key: 'pl',          name: 'P&L',         icon: '📊', color: '#E3674E', tint: '#FBE2DC', description: 'Revenue, costs & profit' },
  { key: 'hr',          name: 'HR',          icon: '👥', color: '#9A6CF0', tint: '#EBE2FC', description: 'Attendance, leaves & payroll' },
  { key: 'payables',    name: 'Payables',    icon: '📤', color: '#D6568D', tint: '#FBE6F0', description: 'Vendor bills & money owed' },
  { key: 'receivables', name: 'Receivables', icon: '📥', color: '#2FB36B', tint: '#DCF5E8', description: 'Customer invoices & collections' },
  { key: 'inventory',   name: 'Inventory',   icon: '📦', color: '#37B6A4', tint: '#DCF2EE', description: 'Stock, bookings & services' },
];

export const MODULE_ORDER: ModuleKey[] = MODULES.map((m) => m.key);

// Each business enables a different subset of system-alert modules. Copied verbatim.
export const BIZ_MODULES: Record<string, ModuleKey[]> = {
  tk: ['crm', 'accounts', 'pl', 'hr', 'payables', 'receivables', 'inventory'],
  qa: ['crm', 'accounts', 'pl', 'inventory'],
  hk: ['crm', 'accounts', 'pl', 'hr', 'receivables', 'inventory'],
  kd: ['crm', 'accounts', 'pl', 'hr', 'payables'],
  adb: ['crm', 'accounts', 'pl'],
  ndb: ['crm', 'accounts', 'pl', 'inventory'],
  kl: ['crm', 'accounts', 'pl', 'inventory', 'payables', 'receivables'],
};
