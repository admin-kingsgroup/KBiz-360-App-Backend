import { businesses } from './businesses';
import { BIZ_MODULES, MODULES, MODULE_ORDER } from '../constants/modules';
import type { ModuleKey } from '../types';

export interface PulseChannel {
  id: string; bizId: string; module: ModuleKey;
  name: string; icon: string; color: string; tint: string; description: string; members: string[];
}
export interface PulseEvent {
  id: string; channelId: string; source: string; title: string; body: string;
  context: string; time: number; read: boolean; actions?: { label: string; primary?: boolean }[];
}

// One channel per (business × enabled module). Copied from source initialPulseChannels.
export const pulseChannels: PulseChannel[] = businesses.flatMap((b) =>
  (BIZ_MODULES[b.id] || []).map((mk) => {
    const m = MODULES.find((x) => x.key === mk)!;
    return { id: `${b.id}_${mk}`, bizId: b.id, module: mk, name: m.name, icon: m.icon, color: m.color, tint: m.tint, description: m.description, members: ['a'] };
  }),
);

const now = Date.now();
const MIN = 60 * 1000, HR = 60 * MIN;

// Copied verbatim from source initialPulse (15 events).
export const pulseEvents: PulseEvent[] = [
  { id: 'pe1', channelId: 'tk_crm', source: 'Leads Bot', title: 'New lead from website', body: 'Ravi Mehta · Bali honeymoon · ₹85k estimated', context: 'TK AMD · Holidays', time: now - 5 * MIN, read: false, actions: [{ label: 'View lead', primary: true }, { label: 'Assign' }] },
  { id: 'pe2', channelId: 'tk_crm', source: 'AI Assistant', title: 'Converted lead → query', body: 'Priya Shah · Dubai 4N · auto-assigned to Mehul', context: 'TK AMD · Holidays', time: now - 9 * MIN, read: false, actions: [{ label: 'View thread', primary: true }] },
  { id: 'pe3', channelId: 'tk_hr', source: 'Attendance System', title: 'Faiz Khan checked in', body: '9:18 AM · 18 minutes late', context: 'TK AMD · Accounts', time: now - 18 * MIN, read: false },
  { id: 'pe4', channelId: 'tk_receivables', source: 'Payment Gateway', title: 'Payment received · ₹2,40,000', body: 'Corporate ticket batch · 12 PAX MUM-LON', context: 'TK BOM · Ticketing', time: now - 22 * MIN, read: false },
  { id: 'pe5', channelId: 'tk_pl', source: 'AI Anomaly Watch', title: 'Pricing anomaly detected', body: '3 EK tickets sold below cost on TK NBO', context: 'TK NBO · Ticketing', time: now - 45 * MIN, read: false, actions: [{ label: 'Review pricing', primary: true }, { label: 'Dismiss' }] },
  { id: 'pe6', channelId: 'tk_hr', source: 'Attendance System', title: 'Mehul Raj checked in', body: '9:00 AM · on time', context: 'TK AMD · Ticketing', time: now - 60 * MIN, read: true },
  { id: 'pe7', channelId: 'tk_inventory', source: 'Booking Engine', title: 'New booking confirmed', body: 'Family of 4 · Goa 6N · Tata AIG insurance bundled', context: 'TK AMD · Holidays', time: now - 70 * MIN, read: true },
  { id: 'pe8', channelId: 'tk_receivables', source: 'Receivables', title: 'Invoice overdue · ₹56,000', body: 'Skyline Corp · 12 days past due', context: 'TK AMD · Accounts', time: now - 2 * HR, read: true },
  { id: 'pe9', channelId: 'tk_payables', source: 'IATA BSP', title: 'BSP refund payable · review', body: '3 mismatches · Emirates · Week 19', context: 'TK AMD · Accounts', time: now - 2.5 * HR, read: false },
  { id: 'pe10', channelId: 'tk_inventory', source: 'Booking Engine', title: 'Cancellation logged', body: 'Mr. Khanna · Singapore 3N · refund processed', context: 'TK BOM · Holidays', time: now - 3 * HR, read: true },
  { id: 'pe11', channelId: 'tk_pl', source: 'Daily Digest', title: 'Daily revenue summary', body: 'TK total today · ₹14.2L · 18% above target', context: 'Travkings', time: now - 4 * HR, read: true },
  { id: 'pe12', channelId: 'tk_accounts', source: 'Ledger', title: 'Bank reconciliation complete', body: '342 entries matched · 0 unresolved', context: 'TK AMD · Accounts', time: now - 5 * HR, read: false },
  { id: 'pe13', channelId: 'tk_inventory', source: 'Inventory System', title: 'Low stock · Travel kits', body: '8 units left · TK AMD store', context: 'TK AMD · Inventory', time: now - 6 * HR, read: true },
  { id: 'pe14', channelId: 'tk_payables', source: 'Payables', title: 'Vendor bill due · ₹1,20,000', body: 'Emirates GSA · due in 3 days', context: 'TK AMD · Accounts', time: now - 7 * HR, read: true },
  { id: 'pe15', channelId: 'tk_accounts', source: 'Month-end', title: 'Month-end close started', body: 'April books · 2 branches pending review', context: 'Travkings', time: now - 8 * HR, read: true },
];

export const moduleRank = (mk: ModuleKey): number => { const i = MODULE_ORDER.indexOf(mk); return i === -1 ? 99 : i; };

// Parse a branch id from an event context ("TK AMD · …" → "amd"); company-wide → null.
export function branchOf(e: PulseEvent): string | null {
  const m = e.context && e.context.match(/\b(AMD|BOM|NBO)\b/);
  return m ? m[1].toLowerCase() : null;
}
