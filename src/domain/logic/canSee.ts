import type { PersonMeta, ReminderViewer, RoleKey } from '../types';
import { RANK } from '../constants/roles';

export const overlap = (a: string[], b: string[]): boolean => a.some((x) => b.includes(x));

export function roleOf(id: string, personMeta: Record<string, PersonMeta>): RoleKey {
  return (personMeta[id] && personMeta[id].role) || 'EMPLOYEE';
}

// Reminder visibility. Extracted verbatim from RemindersScreen.canSee (closes over viewer + PERSON_META).
// Returns true if `viewer` may see reminders addressed to `targetId`.
export function makeCanSee(viewer: ReminderViewer, personMeta: Record<string, PersonMeta>) {
  return (targetId: string): boolean => {
    if (targetId === viewer.id) return true;                 // always your own
    const t = personMeta[targetId];
    if (!t) return false;
    if (RANK[t.role] <= RANK[viewer.role]) return false;     // only strictly below you
    if (viewer.role === 'SUPER_ADMIN') return true;          // everyone
    if (viewer.role === 'DIRECTOR') return true;             // whole business
    if (viewer.role === 'HOD') return t.dept === viewer.dept && overlap(t.branches, viewer.branches);
    return overlap(t.branches, viewer.branches);             // GM / Branch Manager → by branch
  };
}
