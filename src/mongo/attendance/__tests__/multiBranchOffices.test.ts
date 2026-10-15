// Owner 2026-10-15: "if a user has multiple branch access he can mark attendance at any branch" —
// Faiz has every branch but was locked to Bombay HQ, so the punch at BOM was refused. Multi-branch
// users now punch at any active office of any of their branches; single-branch users are unchanged.
// No DB: access, assignments and offices are stubbed.
import type { MongoAccess } from '../../access';

type Office = { _id: string; branchId: string; tenantId: string; label: string; lat: number; lng: number; radius: number; wifiSsid: null; active: boolean; isDefault: boolean };
const office = (id: string, branchId: string, lat: number, lng: number, extra: Partial<Office> = {}): Office =>
  ({ _id: id, branchId, tenantId: 't1', label: id, lat, lng, radius: 100, wifiSsid: null, active: true, isDefault: false, ...extra });

const OFFICES: Office[] = [
  office('mhub-hq', 'MHUB', 19.146724, 72.82933, { isDefault: true }),
  office('bom-hq', 'BOM', 19.0728, 72.8826, { isDefault: true }),
  office('bom-ops', 'BOM', 19.1136, 72.8697),
  office('amd', 'AMD', 23.0308889, 72.5711944, { isDefault: true, radius: 150 }),
  office('nbo-old', 'NBO', -1.2921, 36.8219, { active: false }),
];
const at = (id: string) => { const o = OFFICES.find((x) => x._id === id)!; return { lat: o.lat, lng: o.lng }; };

const accessById = new Map<string, Partial<MongoAccess>>();
const officeOf = new Map<string, string>();
const workBranchOf = new Map<string, string>();

jest.mock('../../access', () => ({
  accessService: { accessForUserId: async (id: string) => (accessById.has(id) ? { tenantId: 't1', ...accessById.get(id) } : null) },
}));
jest.mock('../userOffices', () => ({ userOffices: { officeIdFor: async (id: string) => officeOf.get(id) ?? null } }));
jest.mock('../userWorkBranches', () => ({ userWorkBranches: { branchIdFor: async (id: string) => workBranchOf.get(id) ?? null } }));
jest.mock('../../attendanceHidden', () => ({ attendanceHidden: { isHidden: async () => false } }));
jest.mock('../office.repository', () => ({
  officeRepo: {
    byBranchIds: async (ids: string[]) => OFFICES.filter((o) => ids.includes(o.branchId) && o.active),
    listByTenant: async () => OFFICES, // every office, inactive included — like the real query
    byId: async (id: string) => OFFICES.find((o) => o._id === id) ?? null,
  },
}));

import { attendanceService, officesForUser } from '../attendance.service';

const ids = async (userId: string) => (await officesForUser(userId)).map((o) => String(o._id)).sort();

describe('which offices a user may punch at', () => {
  afterEach(() => { accessById.clear(); officeOf.clear(); workBranchOf.clear(); });

  it('an all-branch user locked to one office can punch at BOM (the Faiz case)', async () => {
    accessById.set('faiz', { companyWide: true, branchIds: null });
    officeOf.set('faiz', 'mhub-hq');
    expect(await ids('faiz')).toEqual(['amd', 'bom-hq', 'bom-ops', 'mhub-hq']); // inactive NBO left out
    await expect(attendanceService.assertAtOffice('faiz', { coords: at('bom-hq') })).resolves.toMatchObject({ distance: 0 });
    await expect(attendanceService.assertAtOffice('faiz', { coords: at('bom-ops') })).resolves.toMatchObject({ distance: 0 });
  });

  it('a user with several CRM branches can punch at every office of each, even with an office lock', async () => {
    accessById.set('multi', { companyWide: false, branchIds: ['BOM', 'AMD'] });
    officeOf.set('multi', 'bom-hq');
    expect(await ids('multi')).toEqual(['amd', 'bom-hq', 'bom-ops']);
    await expect(attendanceService.assertAtOffice('multi', { coords: at('amd') })).resolves.toMatchObject({ distance: 0 });
  });

  it('a multi-branch user keeps a working branch or assigned office that lies outside their branches', async () => {
    accessById.set('lent', { companyWide: false, branchIds: ['BOM', 'AMD'] });
    workBranchOf.set('lent', 'NBO'); // NBO's only office is inactive → nothing added
    officeOf.set('lent', 'mhub-hq');
    expect(await ids('lent')).toEqual(['amd', 'bom-hq', 'bom-ops', 'mhub-hq']);
  });

  it('a single-branch user stays locked to their assigned office', async () => {
    accessById.set('single', { companyWide: false, branchIds: ['BOM'] });
    officeOf.set('single', 'bom-hq');
    expect(await ids('single')).toEqual(['bom-hq']);
    await expect(attendanceService.assertAtOffice('single', { coords: at('bom-ops') })).rejects.toThrow('You must be within 100 m of your office');
  });

  it('a single-branch user with no assignment keeps the branch default office', async () => {
    accessById.set('plain', { companyWide: false, branchIds: ['BOM'] });
    expect(await ids('plain')).toEqual(['bom-hq']);
  });

  it('a single-branch user with the same branch listed twice is still single-branch', async () => {
    accessById.set('dupe', { companyWide: false, branchIds: ['BOM', 'BOM'] });
    officeOf.set('dupe', 'bom-hq');
    expect(await ids('dupe')).toEqual(['bom-hq']);
  });
});
