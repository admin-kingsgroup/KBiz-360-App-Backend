import { colors } from '../theme/colors';

// Direct-message list shown in Home › Chats. Mock data copied from source `directChats`.
// NOTE (source-faithful): this list is NOT access-filtered and NOT affected by View-As —
// it only excludes the signed-in user and sorts unread-first then most-recent.
export interface DirectChatItem {
  id: string;
  name: string;
  initials: string;
  color: string;
  preview: string;
  time: string;
  ts: number;
  unread?: number;
  online?: boolean;
  role?: string;
}

const now = Date.now();

export const directChats: DirectChatItem[] = [
  { id: 'u1', name: 'Afshin Dhanani', initials: 'AD', color: colors.ink,    preview: 'Pls share AMD revenue snapshot today.', time: '9:38 AM', ts: now - 10 * 60 * 1000, unread: 2, online: true, role: 'Super Admin' },
  { id: 'u2', name: 'Farhan Aga',     initials: 'FA', color: colors.purple, preview: 'Booked GVA-NBO for branch review.',     time: '8:51 AM', ts: now - 57 * 60 * 1000, role: 'Business View · Travkings' },
  { id: 'u3', name: 'Faiz Khan',      initials: 'FK', color: colors.orange, preview: 'April MIS attached — Q1 closed strong', time: '8:12 AM', ts: now - 96 * 60 * 1000, unread: 1, online: true, role: 'Branch View · 3 branches' },
  { id: 'u4', name: 'Mehul Raj',      initials: 'MR', color: colors.blue,   preview: 'Done with EK refund corrections', time: 'Yest', ts: now - 26 * 60 * 60 * 1000, role: 'Employee · TK AMD Ticketing' },
  { id: 'u5', name: 'Riya Patel',     initials: 'RP', color: colors.teal,   preview: 'Bali itinerary v3 ready for review',    time: 'Yest', ts: now - 29 * 60 * 60 * 1000, role: 'Employee · TK AMD Holidays' },
  { id: 'u6', name: 'Sanjay Nair',    initials: 'SN', color: colors.coral,  preview: 'BOM branch — corporate lead update',    time: 'Mon',  ts: now - 3 * 24 * 60 * 60 * 1000, role: 'Employee · TK BOM' },
  { id: 'u7', name: 'Karen Owino',    initials: 'KO', color: '#6D6D72',     preview: 'NBO holiday packages — Q3 plan',        time: 'Mon',  ts: now - 3.3 * 24 * 60 * 60 * 1000, role: 'Employee · TK NBO' },
];

// Source sort: unread chats first, then most recent. Self-exclusion done by caller.
export function sortChats(list: DirectChatItem[]): DirectChatItem[] {
  return [...list].sort((a, b) => {
    const ua = (a.unread || 0) > 0 ? 1 : 0;
    const ub = (b.unread || 0) > 0 ? 1 : 0;
    if (ua !== ub) return ub - ua;
    return (b.ts || 0) - (a.ts || 0);
  });
}

// Map the DM list into the foundation Chat shape — used to seed chatStore so unread can be
// marked read when a chat is opened. Display fields (initials/color/time) stay on DirectChatItem.
import type { Chat } from '../types';
export function directChatsAsChats(): Chat[] {
  return directChats.map((c) => ({ id: c.id, kind: 'direct' as const, name: c.name, unread: c.unread || 0, ts: c.ts, preview: c.preview, online: c.online }));
}
