// Leave applications and time corrections announce into the branch's HR ALERT channel — the
// app's Alerts ▸ HR section — never into a group chat. Before 2026-10-06 they posted into the
// HR group and fell back to the Finance group, so MHUB's asks surfaced in "MHUB - Finance Team".
const record = jest.fn();
jest.mock('../../alerts/alert.service', () => ({ alertService: { record: (...a: unknown[]) => record(...a) } }));
jest.mock('../../crm.repo', () => ({ crmRepo: { getUserById: jest.fn(), branchesByIds: jest.fn() } }));
jest.mock('../../attendance/userWorkBranches', () => ({ userWorkBranches: { branchIdFor: jest.fn() } }));

import { postToBranchHrAlerts } from '../hrNotify';

describe('postToBranchHrAlerts', () => {
  beforeEach(() => {
    record.mockReset();
    record.mockResolvedValue({ duplicate: false });
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('posts into the branch HR alert channel (tk_hr_<branch>), not a chat room', async () => {
    const res = await postToBranchHrAlerts({
      branchCode: 'MHUB', title: '📝 Faiz Patel applied for leave · 2026-09-15 (1d)', body: 'Reason: Holiday',
      dedupeKey: 'leave-apply-1', actorUserId: 'u1', source: 'Leave',
    });
    expect(res).toEqual({ posted: true, duplicate: false, channel: 'HR - MHUB' });
    expect(record).toHaveBeenCalledWith(
      'tk_hr_mhub',
      { source: 'Leave', title: '📝 Faiz Patel applied for leave · 2026-09-15 (1d)', body: 'Reason: Holiday', context: 'TK MHUB · HR' },
      'u1',
      'leave-apply-1',
    );
  });

  it('accepts the ERP\'s renamed Africa codes (HNBO → tk_hr_nbo) and defaults the label to HR', async () => {
    await postToBranchHrAlerts({ branchCode: 'HNBO', title: 't' });
    expect(record).toHaveBeenCalledWith('tk_hr_nbo', expect.objectContaining({ source: 'HR', body: '', context: 'TK NBO · HR' }), null, undefined);
  });

  it('reports a dedupe hit as not posted', async () => {
    record.mockResolvedValue({ duplicate: true });
    await expect(postToBranchHrAlerts({ branchCode: 'BOM', title: 't', dedupeKey: 'k' })).resolves.toEqual({ posted: false, duplicate: true, channel: 'HR - BOM' });
  });

  it('never throws: an unknown branch or a failing record() is a warning only', async () => {
    await expect(postToBranchHrAlerts({ branchCode: 'ZZZ', title: 't' })).resolves.toEqual({ posted: false, duplicate: false, channel: '' });
    expect(record).not.toHaveBeenCalled();
    record.mockRejectedValue(new Error('db down'));
    await expect(postToBranchHrAlerts({ branchCode: 'BOM', title: 't' })).resolves.toEqual({ posted: false, duplicate: false, channel: '' });
    expect(console.warn).toHaveBeenCalledTimes(2);
  });
});
