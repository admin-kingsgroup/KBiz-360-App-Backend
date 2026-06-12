import { deriveAccess } from '../logic/access';
import { makeAccessFilters } from '../logic/accessFilters';
import { adminUsers } from '../data/users';

const byId = (id: string) => adminUsers.find((u) => u.id === id)!;

describe('deriveAccess — per role (from adminUsers)', () => {
  it('SUPER_ADMIN → fully unrestricted (null) + canManage', () => {
    const a = deriveAccess(byId('a1'));
    expect(a.isSuper).toBe(true);
    expect(a.bizIds).toBeNull();
    expect(a.branches).toBeNull();
    expect(a.groups).toBeNull();
    expect(a.depts).toBeNull();
    expect(a.alerts).toBeNull();
    expect(a.canManage).toBe(true);
  });

  it('DIRECTOR → scoped to own business, all granted branches, canManage true', () => {
    const a = deriveAccess(byId('a2'));
    expect(a.isSuper).toBe(false);
    expect(a.bizIds).toEqual(['tk']);
    expect(a.branches).toEqual(['AMD', 'BOM', 'NBO']);
    expect(a.canManage).toBe(true); // Director manages
    expect(a.groups).toContain('AMD-Accounts');
  });

  it('GENERAL_MANAGER → only selected branches, canManage false', () => {
    const a = deriveAccess(byId('a3'));
    expect(a.bizIds).toEqual(['tk']);
    expect(a.branches).toEqual(['AMD', 'BOM']);
    expect(a.canManage).toBe(false);
  });

  it('HOD → branch + dept grants, canManage false', () => {
    const a = deriveAccess(byId('a5'));
    expect(a.branches).toEqual(['AMD']);
    expect(a.groups).toEqual(['AMD-Ticketing']);
    expect(a.depts).toEqual(['AMD-Ticketing']);
    expect(a.canManage).toBe(false);
  });

  it('EMPLOYEE → single branch / single grants', () => {
    const a = deriveAccess(byId('a8')); // Nurul, BOM
    expect(a.branches).toEqual(['BOM']);
    expect(a.groups).toEqual(['BOM-Ticketing']);
    expect(a.alerts).toEqual(['BOM-crm']);
    expect(a.canManage).toBe(false);
  });
});

describe('access filters — branch-qualified visibility', () => {
  it('Super sees everything (all OK true)', () => {
    const f = makeAccessFilters(deriveAccess(byId('a1')));
    expect(f.bizOK('qa')).toBe(true);
    expect(f.grpOK('NBO', 'MKTG')).toBe(true);
    expect(f.deptOK('BOM', 'Holidays')).toBe(true);
    expect(f.alertOK('AMD', 'inventory')).toBe(true);
  });

  it('Employee (Rohan a6) sees only granted AMD-Ticketing group + AMD-crm alert', () => {
    const f = makeAccessFilters(deriveAccess(byId('a6')));
    expect(f.bizOK('tk')).toBe(true);
    expect(f.bizOK('qa')).toBe(false);
    expect(f.brOK('AMD')).toBe(true);
    expect(f.brOK('BOM')).toBe(false);
    expect(f.grpOK('AMD', 'Ticketing')).toBe(true);
    expect(f.grpOK('AMD', 'Accounts')).toBe(false);
    expect(f.deptOK('AMD', 'Ticketing')).toBe(true);
    expect(f.alertOK('AMD', 'crm')).toBe(true);
    expect(f.alertOK('AMD', 'pl')).toBe(false);
  });

  it('deptOK also matches bare dept name (backward-compat path)', () => {
    const f = makeAccessFilters({ isSuper: false, role: 'HOD', name: 'x', bizIds: ['tk'], branches: ['AMD'], groups: [], depts: ['Accounts'], alerts: [], canManage: false });
    expect(f.deptOK('AMD', 'Accounts')).toBe(true);   // matches bare 'Accounts'
    expect(f.deptOK('XYZ', 'Accounts')).toBe(true);   // bare match regardless of branch
  });
});
