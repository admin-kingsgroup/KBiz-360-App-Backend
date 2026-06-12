import { colors } from '../theme/colors';
import type { Reminder } from '../types';

// Reminders operate in the PERSON_META identity space (ids a, fa, p, f, m, r, sn, ko, an) —
// SEPARATE from adminUsers (a1…) and the DM space (u…). This is the documented second
// identity system; preserved exactly. CURRENT_USER_ID is the reminders-space "me".
export const CURRENT_USER_ID = 'a';
export const HOURS_48 = 48 * 60 * 60 * 1000;

export type ReminderState = 'pending' | 'review' | 'approved';

// Richer record than the foundation Reminder (adds display fields). Extends Reminder so the
// foundation groupReminders/applyCanSee accept it unchanged.
export interface ReminderRecord extends Reminder {
  state: ReminderState;
  byInitials?: string;
  byColor?: string;
  when?: string;
  overdue?: boolean;
  completedAt?: number;
  approvedAt?: number;
}

// Person → business (for the per-reminder accent color). Copied from source PEOPLE_BIZ.
const PEOPLE_BIZ: Record<string, string | null> = { a: null, fa: 'tk', p: 'tk', f: 'tk', m: 'tk', r: 'tk', sn: 'tk', ko: 'tk', an: 'tk' };

export function getReminderBiz(r: ReminderRecord): string {
  if (r.forId === CURRENT_USER_ID && r.byId === CURRENT_USER_ID) return 'personal';
  const otherId = r.forId !== CURRENT_USER_ID ? r.forId : r.byId;
  return PEOPLE_BIZ[otherId] || 'personal';
}

// People available in the composer assignee picker (reminders-space ids).
export const reminderPeople = [
  { id: 'a', name: 'Myself', initials: 'A', color: colors.ink },
  { id: 'fa', name: 'Farhan Aga', initials: 'FA', color: colors.purple },
  { id: 'p', name: 'Pravesh', initials: 'PJ', color: '#0EA5E9' },
  { id: 'f', name: 'Faiz Khan', initials: 'FK', color: colors.orange },
  { id: 'm', name: 'Mehul Raj', initials: 'MR', color: colors.blue },
  { id: 'r', name: 'Riya Patel', initials: 'RP', color: colors.teal },
  { id: 'sn', name: 'Sanjay Nair', initials: 'SN', color: colors.coral },
  { id: 'ko', name: 'Karen Owino', initials: 'KO', color: '#6D6D72' },
];

// Seed reminders — copied verbatim from source (16 records).
export const seedReminders: ReminderRecord[] = [
  { id: 'r1', text: 'Review Q3 strategy deck before Monday board meeting', state: 'pending', forId: 'a', forName: 'Afshin Dhanani', forInitials: 'AD', forColor: colors.ink, byId: 'fa', byName: 'Farhan', byInitials: 'FA', byColor: colors.purple, when: 'Today · 2:00 PM', section: 'today', overdue: false },
  { id: 'r2', text: 'Approve Hotel Kings Palace setup checklist', state: 'pending', forId: 'a', forName: 'Afshin Dhanani', forInitials: 'AD', forColor: colors.ink, byId: 'p', byName: 'Pravesh', byInitials: 'PJ', byColor: '#0EA5E9', when: 'Tomorrow', section: 'week' },
  { id: 'r3', text: 'Final call on ADB industry classification', state: 'pending', forId: 'a', forName: 'Afshin Dhanani', forInitials: 'AD', forColor: colors.ink, byId: 'a', byName: 'Afshin', byInitials: 'A', byColor: colors.ink, when: '', section: 'today' },
  { id: 'r4', text: 'Send AMD monthly revenue snapshot to Afshin', state: 'pending', forId: 'p', forName: 'Pravesh Jha', forInitials: 'PJ', forColor: '#0EA5E9', byId: 'a', byName: 'Afshin', byInitials: 'A', byColor: colors.ink, when: 'Today · 3:00 PM', section: 'today', overdue: false },
  { id: 'r5', text: 'MOM need to discuss with me and then send email to me', state: 'pending', forId: 'f', forName: 'Faiz Khan', forInitials: 'FK', forColor: colors.orange, byId: 'a', byName: 'Afshin', byInitials: 'A', byColor: colors.ink, when: 'Today · 5:00 PM', section: 'today', overdue: false },
  { id: 'r6', text: 'Reconcile BSP refunds week 19 + commentary', state: 'review', forId: 'f', forName: 'Faiz Khan', forInitials: 'FK', forColor: colors.orange, byId: 'a', byName: 'Afshin', byInitials: 'A', byColor: colors.ink, when: 'Today · 3:00 PM', section: 'today' },
  { id: 'r7', text: 'Update CRM tags for VIP clients', state: 'review', forId: 'm', forName: 'Mehul Raj', forInitials: 'MR', forColor: colors.blue, byId: 'a', byName: 'Afshin', byInitials: 'A', byColor: colors.ink, when: 'Today', section: 'today' },
  { id: 'r8', text: 'Share Bali itinerary v3 with client', state: 'approved', forId: 'r', forName: 'Riya Patel', forInitials: 'RP', forColor: colors.teal, byId: 'a', byName: 'Afshin', byInitials: 'A', byColor: colors.ink, when: 'Yesterday', section: 'today' },
  { id: 'r9', text: 'Confirm Dubai hotel rates Q3', state: 'approved', forId: 'f', forName: 'Faiz Khan', forInitials: 'FK', forColor: colors.orange, byId: 'a', byName: 'Afshin', byInitials: 'A', byColor: colors.ink, when: 'Yesterday', section: 'today' },
  { id: 'rv1', text: 'Send Q1 commission statements to all agents', state: 'review', forId: 'm', forName: 'Mehul Raj', forInitials: 'MR', forColor: colors.blue, byId: 'f', byName: 'Faiz Khan', byInitials: 'FK', byColor: colors.orange, when: 'Today', section: 'today' },
  { id: 'rv2', text: 'Update Bali itinerary v3 with new hotel rates', state: 'review', forId: 'r', forName: 'Riya Patel', forInitials: 'RP', forColor: colors.teal, byId: 'f', byName: 'Faiz Khan', byInitials: 'FK', byColor: colors.orange, when: 'Today', section: 'today' },
  { id: 'rv3', text: 'AMD branch P&L review with team', state: 'review', forId: 'f', forName: 'Faiz Khan', forInitials: 'FK', forColor: colors.orange, byId: 'p', byName: 'Pravesh Jha', byInitials: 'PJ', byColor: '#0EA5E9', when: 'Yesterday', section: 'today' },
  { id: 'rv4', text: 'Set up new corporate ticketing workflow', state: 'review', forId: 'm', forName: 'Mehul Raj', forInitials: 'MR', forColor: colors.blue, byId: 'p', byName: 'Pravesh Jha', byInitials: 'PJ', byColor: '#0EA5E9', when: 'Yesterday', section: 'today' },
  { id: 'rv5', text: 'Q3 strategic priorities document', state: 'review', forId: 'f', forName: 'Faiz Khan', forInitials: 'FK', forColor: colors.orange, byId: 'fa', byName: 'Farhan Aga', byInitials: 'FA', byColor: colors.purple, when: 'Today', section: 'today' },
  { id: 'rb1', text: 'Review F&B vendor contracts for HK launch', state: 'pending', forId: 'sn', forName: 'Sanjay Nair', forInitials: 'SN', forColor: colors.coral, byId: 'a', byName: 'Afshin', byInitials: 'A', byColor: colors.ink, when: 'Tomorrow · 11:00 AM', section: 'week' },
  { id: 'rb2', text: 'Send ADB PowerPoint deck for board meeting', state: 'pending', forId: 'ko', forName: 'Karen Owino', forInitials: 'KO', forColor: '#6D6D72', byId: 'a', byName: 'Afshin', byInitials: 'A', byColor: colors.ink, when: 'Today · 4:00 PM', section: 'today' },
];
