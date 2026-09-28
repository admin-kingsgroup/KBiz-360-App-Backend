import { branchMembers, type Audience } from '../alert.push';

// Pure unit test — no DB. Who a branch-wide CRM Alerts push reaches: the branch's own members
// plus company-wide roles; never another branch's staff.
const aud = (): Audience => ({
  at: Date.now(),
  superIds: ['super'],
  disabled: new Set(),
  companyWideIds: ['super', 'gm'],
  members: [
    { id: 'bom-sales', branchIds: ['b-bom'] },
    { id: 'amd-sales', branchIds: ['b-amd'] },
    { id: 'hub-accountant', branchIds: ['b-mhub', 'b-bom', 'b-amd'] },
    { id: 'no-branch', branchIds: [] },
  ],
  branchIdsByCode: new Map([['BOM', ['b-bom']], ['AMD', ['b-amd']], ['MHUB', ['b-mhub']]]),
  erpIds: new Set(),
});

describe('branch-wide alert audience', () => {
  it('reaches the branch members and company-wide roles only', () => {
    expect(branchMembers(aud(), 'BOM').sort()).toEqual(['bom-sales', 'gm', 'hub-accountant', 'super']);
    expect(branchMembers(aud(), 'amd').sort()).toEqual(['amd-sales', 'gm', 'hub-accountant', 'super']);
  });

  it('an H-coded Africa branch row (HNBO) is the NBO audience', () => {
    const a = aud();
    a.branchIdsByCode.set('NBO', ['b-hnbo']); // built through canonicalBranchCode in baseAudience
    a.members.push({ id: 'nbo-sales', branchIds: ['b-hnbo'] });
    expect(branchMembers(a, 'HNBO').sort()).toEqual(['gm', 'nbo-sales', 'super']);
    expect(branchMembers(a, 'NBO').sort()).toEqual(['gm', 'nbo-sales', 'super']);
  });

  it('a branch with no CRM row reaches only company-wide roles', () => {
    expect(branchMembers(aud(), 'DAR').sort()).toEqual(['gm', 'super']);
  });
});
