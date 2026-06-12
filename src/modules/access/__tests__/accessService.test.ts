import type { User as PrismaUser } from '@prisma/client';
import { accessService, toDomainUser } from '../access.service';

// Builds a PrismaUser-shaped row without a DB. AccessService just wraps the verbatim ported
// deriveAccess/makeAccessFilters, so these assertions mirror the frontend access.test.ts exactly.
const row = (over: Partial<PrismaUser>): PrismaUser =>
  ({
    id: 'x',
    name: 'X',
    email: null,
    initials: 'XX',
    color: '#000',
    role: 'EMPLOYEE',
    bizId: 'tk',
    branches: [],
    accessGroups: [],
    accessDepts: [],
    accessAlerts: [],
    attendanceEnabled: null,
    scopeLine: null,
    loginLabel: null,
    passwordHash: null,
    legacyAdminId: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...over,
  }) as unknown as PrismaUser;

describe('AccessService — wraps deriveAccess/makeAccessFilters (no rewrites)', () => {
  it('SUPER_ADMIN → fully unrestricted + canManage', () => {
    const a = accessService.accessForUser(row({ role: 'SUPER_ADMIN', bizId: null }));
    expect(a.isSuper).toBe(true);
    expect(a.bizIds).toBeNull();
    expect(a.branches).toBeNull();
    expect(a.groups).toBeNull();
    expect(a.canManage).toBe(true);
  });

  it('EMPLOYEE (Rohan-like) → scoped grants, canManage false, filters match', () => {
    const u = row({
      role: 'EMPLOYEE',
      bizId: 'tk',
      branches: ['AMD'],
      accessGroups: ['AMD-Ticketing'],
      accessDepts: ['AMD-Ticketing'],
      accessAlerts: ['AMD-crm'],
    });
    const a = accessService.accessForUser(u);
    expect(a.isSuper).toBe(false);
    expect(a.branches).toEqual(['AMD']);
    expect(a.canManage).toBe(false);

    const f = accessService.filtersForUser(u);
    expect(f.bizOK('tk')).toBe(true);
    expect(f.bizOK('qa')).toBe(false);
    expect(f.brOK('AMD')).toBe(true);
    expect(f.brOK('BOM')).toBe(false);
    expect(f.grpOK('AMD', 'Ticketing')).toBe(true);
    expect(f.grpOK('AMD', 'Accounts')).toBe(false);
    expect(f.alertOK('AMD', 'crm')).toBe(true);
    expect(f.alertOK('AMD', 'pl')).toBe(false);
  });

  it('toDomainUser maps grant arrays verbatim (string-for-string)', () => {
    const d = toDomainUser(row({ accessGroups: ['AMD-Accounts', 'BOM-Accounts'] }));
    expect(d.accessGroups).toEqual(['AMD-Accounts', 'BOM-Accounts']);
  });
});
