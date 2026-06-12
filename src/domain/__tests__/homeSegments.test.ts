import { makeAccessFilters } from '../logic/accessFilters';
import { deriveAccess } from '../logic/access';
import { branches, businessDepts } from '../data/businesses';
import { pulseChannels } from '../data/pulse';
import { adminUsers } from '../data/users';

const byId = (id: string) => adminUsers.find((u) => u.id === id)!;

// Reproduces the visibility math the three Home segments use, asserting View-As effects.
describe('Home segments — access filtering (View-As)', () => {
  it('Groups: Super sees all TK branches/groups; Employee(Rohan) sees only AMD-Ticketing', () => {
    const sup = makeAccessFilters(deriveAccess(byId('a1')));
    const supGroups = branches.filter((br) => sup.brOK(br.code)).flatMap((br) => br.groups.filter((g) => sup.grpOK(br.code, g.name)));
    expect(supGroups.length).toBe(15); // 3 branches × 5 groups

    const emp = makeAccessFilters(deriveAccess(byId('a6'))); // Rohan: AMD, AMD-Ticketing
    const empGroups = branches.filter((br) => emp.brOK(br.code)).flatMap((br) => br.groups.filter((g) => emp.grpOK(br.code, g.name)));
    expect(empGroups.map((g) => g.name)).toEqual(['Ticketing']);
  });

  it('Departments: HOD(Harshit) sees only AMD-Ticketing dept', () => {
    const f = makeAccessFilters(deriveAccess(byId('a5'))); // Harshit: AMD, AMD-Ticketing
    const depts = branches.filter((br) => f.brOK(br.code)).flatMap((br) => (businessDepts['tk'] || []).filter((d) => f.deptOK(br.code, d.name)).map((d) => `${br.code}-${d.name}`));
    expect(depts).toEqual(['AMD-Ticketing']);
  });

  it('System Alerts: Employee(Nurul) sees only BOM crm channel', () => {
    const f = makeAccessFilters(deriveAccess(byId('a8'))); // Nurul: BOM, BOM-crm
    const visible = pulseChannels.filter((ch) => f.bizOK(ch.bizId) && f.alertOK(ch.bizId === 'tk' ? null : ch.bizId, ch.module));
    // branch-wise alert access: BOM-crm only
    const bomVisible = pulseChannels.filter((ch) => ch.bizId === 'tk' && f.alertOK('BOM', ch.module)).map((ch) => ch.module);
    expect(bomVisible).toEqual(['crm']);
    expect(visible.every((ch) => ch.bizId === 'tk')).toBe(true); // Nurul only in tk
  });

  it('Super sees alert channels across all businesses', () => {
    const f = makeAccessFilters(deriveAccess(byId('a1')));
    const visible = pulseChannels.filter((ch) => f.bizOK(ch.bizId) && f.alertOK(null, ch.module));
    expect(visible.length).toBe(pulseChannels.length);
  });
});
