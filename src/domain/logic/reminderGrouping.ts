import type { PersonMeta, Reminder, ReminderGroup, ReminderViewer, RoleDef, RoleKey } from '../types';
import { RANK, ROLE_OPTIONS } from '../constants/roles';
import { makeCanSee, roleOf } from './canSee';

const sectionRank = (s: string): number => (({ today: 0, week: 1 } as Record<string, number>)[s] ?? 2);

// Apply "All"-tab canSee filtering. Extracted from: if (isAll) visible = live.filter(canSee(forId)).
export function applyCanSee(
  live: Reminder[],
  viewer: ReminderViewer,
  personMeta: Record<string, PersonMeta>,
): Reminder[] {
  const canSee = makeCanSee(viewer, personMeta);
  return live.filter((r) => canSee(r.forId));
}

// Group reminders. isAll -> name-wise (by person, ordered by RANK then name);
// else -> role-tier (ROLE_OPTIONS order). Extracted verbatim from RemindersScreen section builder.
export function groupReminders(
  visible: Reminder[],
  opts: { isAll: boolean; personMeta: Record<string, PersonMeta>; roleDefs: Record<RoleKey, RoleDef> },
): ReminderGroup[] {
  const { isAll, personMeta, roleDefs } = opts;
  if (isAll) {
    const byPerson: Record<string, Reminder[]> = {};
    visible.forEach((r) => { (byPerson[r.forId] ||= []).push(r); });
    const ids = Object.keys(byPerson).sort((x, y) =>
      (RANK[roleOf(x, personMeta)] - RANK[roleOf(y, personMeta)]) ||
      (byPerson[x][0].forName || '').localeCompare(byPerson[y][0].forName || ''));
    return ids.map((id) => {
      const first = byPerson[id][0];
      const rd = roleDefs[roleOf(id, personMeta)];
      byPerson[id].sort((a, b) => sectionRank(a.section) - sectionRank(b.section));
      return { key: id, mode: 'person', name: first.forName, initials: first.forInitials, avColor: first.forColor, sub: rd ? rd.label : '', items: byPerson[id] };
    });
  }
  const byRole: Record<string, Reminder[]> = {};
  visible.forEach((r) => { const k = roleOf(r.forId, personMeta); (byRole[k] ||= []).push(r); });
  Object.keys(byRole).forEach((k) => byRole[k].sort((a, b) => sectionRank(a.section) - sectionRank(b.section)));
  return ROLE_OPTIONS
    .filter((k) => byRole[k] && byRole[k].length)
    .map((k) => ({ key: k, mode: 'role', label: roleDefs[k].label, color: roleDefs[k].color, items: byRole[k] }));
}
