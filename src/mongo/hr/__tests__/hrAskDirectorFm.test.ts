// HR ASKS ARE SIGNED DIRECTOR → FM, NO OWNER (owner, 2026-11-02 — "remove the Owner: first the Director, then the Finance
// Manager, then it is approved; the Owner only reviews"). Pinned here: a Director's own WFH is stamped Owner → FM (the Owner
// in his place, as the ERP does), and the Super Admin's in-app decision on a time correction is refused once the row's
// chain has no Owner level — it still decides one left on the old FM → Director → Owner chain.
const mockRepo = {
  employeeByUserId: jest.fn(),
  openLeaveApplications: jest.fn(),
  insertLeaveApplication: jest.fn(),
  getTimeCorrection: jest.fn(),
  decideTimeCorrection: jest.fn(),
};
jest.mock('../hr.repo', () => ({ hrRepo: mockRepo }));
jest.mock('../../crm.repo', () => ({ crmRepo: { getUserById: jest.fn(), listUsers: jest.fn() } }));
jest.mock('../../access', () => ({ accessService: { accessForUserId: jest.fn() } }));
jest.mock('../hrNotify', () => ({
  hrBranchCodeFor: () => Promise.resolve('BOM'),
  nameOfUser: () => 'Unknown',
  postToBranchHrAlerts: () => Promise.resolve({ posted: true }),
}));
jest.mock('../../attendance/attendanceBranch', () => ({ dayKeyIn: () => '2026-11-02' }));
jest.mock('../leaveDecision.sweep', () => ({ sweepLeaveDecisions: () => Promise.resolve() }));

import { Types } from 'mongoose';
import { accessService } from '../../access';
import { crmRepo } from '../../crm.repo';
import { wfhService } from '../wfh.service';
import { regularizationService } from '../regularization.service';
import { freshChain, LEAVE_CHAIN } from '../timeCorrection.rules';

const A = new Types.ObjectId().toHexString();
const ADMIN = new Types.ObjectId().toHexString();

describe('a WFH filed by the Director', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockRepo.openLeaveApplications.mockResolvedValue([]);
    mockRepo.insertLeaveApplication.mockImplementation(async (d: object) => ({ _id: new Types.ObjectId(), ...d }));
    (crmRepo.getUserById as jest.Mock).mockResolvedValue(null);
  });
  it('is stamped Owner → FM — the Director never confirms his own', async () => {
    mockRepo.employeeByUserId.mockResolvedValue({ userId: A, name: 'Farhan', branch: 'MHUB', designation: 'Director' });
    await wfhService.apply(A, { from: '2026-11-04', to: '2026-11-04', reason: 'site visit' });
    expect(mockRepo.insertLeaveApplication.mock.calls[0][0].chain.map((l: { role: string }) => l.role)).toEqual(['Owner', 'FinanceManager']);
  });
  it('anyone else: Director → FM', async () => {
    mockRepo.employeeByUserId.mockResolvedValue({ userId: A, name: 'Eric', branch: 'BOM', designation: 'Executive' });
    await wfhService.apply(A, { from: '2026-11-04', to: '2026-11-04', reason: 'plumber' });
    expect(mockRepo.insertLeaveApplication.mock.calls[0][0].chain.map((l: { role: string }) => l.role)).toEqual(['Director', 'FinanceManager']);
  });
});

describe('the Super Admin\'s in-app decision on a time correction', () => {
  const row = (chain: { order: number; role: string; label: string }[]) => ({
    _id: new Types.ObjectId(), userId: A, name: 'Eric', branch: 'BOM', from: '2026-10-27', to: '2026-10-27', reason: 'forgot', status: 'pending',
    appliedAt: new Date('2026-10-28T10:00:00Z'), decidedBy: '', decidedAt: null, decisionNote: '', checkIn: '10:30', checkOut: '19:30', chain, approvals: [],
  });
  beforeEach(() => {
    jest.resetAllMocks();
    (accessService.accessForUserId as jest.Mock).mockResolvedValue({ isSuper: true, tenantId: '' });
    (crmRepo.getUserById as jest.Mock).mockResolvedValue({ _id: A, email: 'x@kb.com' });
  });
  it('is refused on a Director → FM row — the Owner reviews it, the ERP decides it', async () => {
    mockRepo.getTimeCorrection.mockResolvedValue(row(freshChain()));
    await expect(regularizationService.decide(ADMIN, 'id1', { action: 'approve' })).rejects.toMatchObject({ status: 403, code: 'OWNER_REVIEWS_ONLY' });
    await expect(regularizationService.decide(ADMIN, 'id1', { action: 'reject', note: 'no' })).rejects.toMatchObject({ status: 403, code: 'OWNER_REVIEWS_ONLY' });
    expect(mockRepo.decideTimeCorrection).not.toHaveBeenCalled();
  });
  it('a row still on FM → Director → Owner may still be rejected here (the old door, until the ERP moves it)', async () => {
    mockRepo.getTimeCorrection.mockResolvedValue(row(LEAVE_CHAIN.map((l) => ({ ...l }))));
    mockRepo.decideTimeCorrection.mockResolvedValue(true);
    const r = await regularizationService.decide(ADMIN, 'id1', { action: 'reject', note: 'no proof' }).catch((e: Error) => e);
    if (r instanceof Error) throw r;
    expect(mockRepo.decideTimeCorrection).toHaveBeenCalledWith('id1', expect.objectContaining({ status: 'rejected' }), []);
  });
});
