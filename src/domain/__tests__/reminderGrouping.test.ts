import { applyCanSee, groupReminders } from '../logic/reminderGrouping';
import { PERSON_META, ROLE_VIEWERS } from '../data/users';
import { ROLE_DEFS } from '../constants/roles';
import type { Reminder } from '../types';

const mk = (id: string, forId: string, forName: string, section: string): Reminder =>
  ({ id, forId, forName, section, byId: 'a' });

// reminders addressed to people across tiers
const live: Reminder[] = [
  mk('r1', 'p', 'Pravesh', 'today'),    // GM
  mk('r2', 'm', 'Mehul', 'week'),       // HOD
  mk('r3', 'r', 'Riya', 'today'),       // EMP AMD
  mk('r4', 'fa', 'Farhan', 'today'),    // Director
  mk('r5', 'an', 'Anjali', 'week'),     // EMP BOM
];

describe('applyCanSee (All tab filtering)', () => {
  it('Super sees all', () => {
    expect(applyCanSee(live, ROLE_VIEWERS.SUPER_ADMIN, PERSON_META).length).toBe(5);
  });
  it('Branch Manager (AMD) sees only AMD HOD/staff below', () => {
    const vis = applyCanSee(live, ROLE_VIEWERS.BRANCH_MANAGER, PERSON_META).map((r) => r.forId).sort();
    expect(vis).toEqual(['m', 'r']); // HOD AMD + emp AMD; not p (GM above), not BOM staff
  });
});

describe('groupReminders', () => {
  it('All tab → person-wise, ordered by RANK then name', () => {
    const groups = groupReminders(live, { isAll: true, personMeta: PERSON_META, roleDefs: ROLE_DEFS });
    expect(groups.every((g) => g.mode === 'person')).toBe(true);
    // order: fa(Director r1) , p(GM) , m(HOD) , then employees by name (Anjali, Riya)
    expect(groups.map((g) => g.key)).toEqual(['fa', 'p', 'm', 'an', 'r']);
    expect(groups[0].sub).toBe(ROLE_DEFS.DIRECTOR.label);
  });

  it('non-All → role-tier, in hierarchy order', () => {
    const groups = groupReminders(live, { isAll: false, personMeta: PERSON_META, roleDefs: ROLE_DEFS });
    expect(groups.every((g) => g.mode === 'role')).toBe(true);
    expect(groups.map((g) => g.key)).toEqual(['DIRECTOR', 'GENERAL_MANAGER', 'HOD', 'EMPLOYEE']);
  });

  it('within a person, today sorts before week', () => {
    const multi: Reminder[] = [mk('x1', 'r', 'Riya', 'week'), mk('x2', 'r', 'Riya', 'today')];
    const groups = groupReminders(multi, { isAll: true, personMeta: PERSON_META, roleDefs: ROLE_DEFS });
    expect(groups[0].items.map((i) => i.section)).toEqual(['today', 'week']);
  });
});
