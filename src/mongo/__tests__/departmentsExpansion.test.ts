import { Types } from 'mongoose';

// Departments are company-wide: every branch of a company must list the company's full department
// set — a branch created after the CRM department rows (INB, MHUB) still gets all of them, and an
// app-created department reaches every branch. Regression for INB showing only "KBIZ360 - SUPPORT".
jest.mock('../crm.repo', () => ({ crmRepo: { listDepartments: jest.fn(), listBranches: jest.fn(), branchesByIds: jest.fn() } }));
jest.mock('../appDepartments', () => ({ appDepartments: { listByTenant: jest.fn() } }));
jest.mock('../userPositions', () => ({ userPositions: { mapFor: jest.fn() } }));
jest.mock('../userAvatars', () => ({ userAvatars: { mapFor: jest.fn() } }));
jest.mock('../access', () => ({ accessService: { accessForUserId: jest.fn() } }));
jest.mock('../appAccess', () => ({ appAccess: { disabledSet: jest.fn() } }));

import { crmRepo } from '../crm.repo';
import { appDepartments } from '../appDepartments';
import { directoryService } from '../directory.service';
import type { MongoAccess } from '../access';

const oid = (hex: string) => new Types.ObjectId(hex.padStart(24, '0'));
const TENANT = oid('aa');
const C1 = oid('c1'); // Travkings-like company
const C2 = oid('c2'); // unrelated company
const B_OLD = oid('b1'); // has its own CRM department rows
const B_NEW = oid('b2'); // created later — no CRM rows (the INB case)
const B_OTHER = oid('b3'); // branch of C2

const branches = [
  { _id: B_OLD, code: 'BOM', name: 'Old', company_id: C1, tenant_id: TENANT },
  { _id: B_NEW, code: 'INB', name: 'New', company_id: C1, tenant_id: TENANT },
  { _id: B_OTHER, code: 'XX', name: 'Other', company_id: C2, tenant_id: TENANT },
];
// _id order makes the B_OLD rows canonical (oldest wins), so expanded ids are stable.
const crmDepts = [
  { _id: oid('d1'), name: 'Marketing', code: 'MKT', branch_id: B_OLD, company_id: C1, tenant_id: TENANT },
  { _id: oid('d2'), name: 'Finance', code: 'FIN', branch_id: B_OLD, company_id: C1, tenant_id: TENANT },
];
const appDeptSupport = {
  _id: oid('a1'), name: 'Support', companyId: String(C1), branchId: null,
  icon: null, color: '#123456', active: true, tenantId: String(TENANT), createdBy: null,
};

const superAccess = {
  userId: 'u1', tenantId: String(TENANT), roleName: 'super_admin', level: 1,
  isSuper: true, canManage: true, companyWide: true, branchIds: null, permissions: ['*'],
} as MongoAccess;

const byBranch = (rows: { branchId: string | null; name: string | null }[], branch: Types.ObjectId) =>
  rows.filter((r) => r.branchId === String(branch)).map((r) => r.name).sort();

beforeEach(() => {
  jest.clearAllMocks();
  (crmRepo.listDepartments as jest.Mock).mockResolvedValue(crmDepts);
  (crmRepo.listBranches as jest.Mock).mockResolvedValue(branches);
  (crmRepo.branchesByIds as jest.Mock).mockImplementation(async (ids: Types.ObjectId[]) =>
    branches.filter((b) => ids.some((i) => String(i) === String(b._id))));
  (appDepartments.listByTenant as jest.Mock).mockResolvedValue([appDeptSupport]);
});

describe('directoryService.listDepartments — company-wide expansion', () => {
  it('gives a branch with no CRM rows the full company set (CRM + app)', async () => {
    const out = await directoryService.listDepartments(superAccess);
    expect(byBranch(out, B_NEW)).toEqual(['Finance', 'Marketing', 'Support']);
    expect(byBranch(out, B_OLD)).toEqual(['Finance', 'Marketing', 'Support']);
  });

  it('keeps the original row ids on branches that have them and reuses the canonical id elsewhere', async () => {
    const out = await directoryService.listDepartments(superAccess);
    const oldMkt = out.find((d) => d.branchId === String(B_OLD) && d.name === 'Marketing');
    const newMkt = out.find((d) => d.branchId === String(B_NEW) && d.name === 'Marketing');
    expect(oldMkt?.id).toBe(String(oid('d1')));
    expect(newMkt?.id).toBe(String(oid('d1'))); // deptKey "<branchId>:<id>" still unique per branch
  });

  it('never leaks departments across companies', async () => {
    const out = await directoryService.listDepartments(superAccess);
    expect(byBranch(out, B_OTHER)).toEqual([]);
  });

  it('honours the branchId filter', async () => {
    const out = await directoryService.listDepartments(superAccess, String(B_NEW));
    expect(out.every((d) => d.branchId === String(B_NEW))).toBe(true);
    expect(byBranch(out, B_NEW)).toEqual(['Finance', 'Marketing', 'Support']);
  });

  it('gives a branch-scoped user of the new branch the full set (old code returned none)', async () => {
    const scoped = { ...superAccess, isSuper: false, canManage: false, companyWide: false, level: 5, branchIds: [String(B_NEW)] } as MongoAccess;
    const out = await directoryService.listDepartments(scoped);
    expect(byBranch(out, B_NEW)).toEqual(['Finance', 'Marketing', 'Support']);
    expect(byBranch(out, B_OLD)).toEqual([]); // still only their own branch
  });

  it('does not duplicate a same-named app department on any branch', async () => {
    (appDepartments.listByTenant as jest.Mock).mockResolvedValue([
      appDeptSupport,
      { ...appDeptSupport, _id: oid('a2'), name: 'Marketing' },
    ]);
    const out = await directoryService.listDepartments(superAccess);
    expect(byBranch(out, B_OLD)).toEqual(['Finance', 'Marketing', 'Support']);
    expect(byBranch(out, B_NEW)).toEqual(['Finance', 'Marketing', 'Support']);
  });
});
