// WORK FROM HOME and the SATURDAY SWAP (owner, 2026-10-12) — the app's half. The rows are the ERP's own
// hr_leave_applications (kind 'wfh' / 'swap'); the ERP's Owner signature writes the days. Pinned here: the classifier
// port reads the new overrides exactly as the ERP does, swapProblem is the ERP's check verbatim, the swap reads from
// each side's own perspective, both people hear the decision, and the service files / answers / withdraws correctly.
const mockRepo = {
  employeeByUserId: jest.fn(),
  overridesOn: jest.fn(),
  openSwapsTouching: jest.fn(),
  employeesOfBranch: jest.fn(),
  insertLeaveApplication: jest.fn(),
  getLeaveApplication: jest.fn(),
  answerSwap: jest.fn(),
  cancelLeaveApplication: jest.fn(),
  listSwaps: jest.fn(),
  openLeaveApplications: jest.fn(),
};
const recordUserAlert = jest.fn();
const postHr = jest.fn();
jest.mock('../hr.repo', () => ({ hrRepo: mockRepo }));
jest.mock('../../crm.repo', () => ({ crmRepo: { getUserById: jest.fn(), listUsers: jest.fn() } }));
jest.mock('../../alerts/alert.service', () => ({ alertService: { recordUserAlert: (...a: unknown[]) => recordUserAlert(...a) } }));
const hrBranchCodeFor = jest.fn();
jest.mock('../hrNotify', () => ({
  hrBranchCodeFor: (...a: unknown[]) => hrBranchCodeFor(...a),
  nameOfUser: (u: { first_name?: string } | null) => (u?.first_name ?? 'Unknown'),
  postToBranchHrAlerts: (...a: unknown[]) => postHr(...a),
}));
jest.mock('../../attendance/attendanceBranch', () => ({ dayKeyIn: () => '2026-10-12' }));

import { Types } from 'mongoose';
import { crmRepo } from '../../crm.repo';
import { classifyDay, summarizeMonth } from '../attendanceMonth';
import { sideOf, swapBusyByPerson, swapProblem, toSwapDto, upcomingSaturdays, swapWaitingOn } from '../swapRules';
import { decisionAlerts, decisionAlert } from '../leaveDecision.sweep';
import { swapService } from '../swap.service';
import { wfhService } from '../wfh.service';
import { swapRequestSchema, swapRespondSchema, wfhApplySchema } from '../hr.router';
import type { HrLeaveApplicationDoc } from '../hr.repo';

const ODD = { days: [0], saturdays: 'odd' };   // off 1st / 3rd / 5th Saturdays
const EVEN = { days: [0], saturdays: 'even' }; // off 2nd / 4th
const A = new Types.ObjectId().toHexString();
const B = new Types.ObjectId().toHexString();
const C = new Types.ObjectId().toHexString();

describe('classifyDay — the ERP reading of WFH and swapped Saturdays', () => {
  const today = '2026-10-20';
  it('WFH: present without a punch, never late; a punch on it is an ordinary day', () => {
    expect(classifyDay('2026-10-14', { override: { state: 'wfh' }, today, policy: ODD, shift: { start: '10:00', graceMinutes: 10 } }))
      .toMatchObject({ state: 'present', wfh: true, late: false, hours: null });
    expect(classifyDay('2026-10-28', { override: { state: 'wfh' }, today, policy: ODD })).toMatchObject({ state: 'present', wfh: true });
    expect(classifyDay('2026-10-14', { record: { checkInAt: new Date('2026-10-14T04:00:00Z') }, override: { state: 'wfh' }, today, policy: ODD }))
      .toMatchObject({ state: 'present', wfh: false });
  });
  it('swapWork: their own week-off Saturday is a working day; swapOff: a working Saturday is a week off', () => {
    expect(classifyDay('2026-10-17', { today, policy: ODD })).toMatchObject({ state: 'weekOff' });
    expect(classifyDay('2026-10-17', { override: { state: 'swapWork' }, today, policy: ODD })).toMatchObject({ state: 'absent', weekOff: false, swap: 'work' });
    expect(classifyDay('2026-10-10', { override: { state: 'swapOff' }, today, policy: ODD })).toMatchObject({ state: 'weekOff', weekOff: true, swap: 'off', granted: false });
  });
  it('summary: WFH inside present; swapped days counted', () => {
    const s = summarizeMonth([
      classifyDay('2026-10-14', { override: { state: 'wfh' }, today, policy: ODD }),
      classifyDay('2026-10-10', { override: { state: 'swapOff' }, today, policy: ODD }),
      classifyDay('2026-10-17', { override: { state: 'swapWork' }, record: { checkInAt: new Date('2026-10-17T04:00:00Z'), checkOutAt: new Date('2026-10-17T12:00:00Z') }, today, policy: ODD }),
    ]);
    expect(s).toMatchObject({ present: 2, wfh: 1, weekOffs: 1, swapped: 2, workedOnWeekOff: 0 });
  });
});

describe('swapProblem — the ERP check, verbatim', () => {
  const mine = sideOf('Asha', ODD);
  const theirs = sideOf('Bilal', EVEN);
  const ok = { workDay: '2026-10-17', offDay: '2026-10-24', mine, theirs, today: '2026-10-12' };
  it('fits; each refusal said', () => {
    expect(swapProblem(ok)).toBe('');
    expect(swapProblem({ ...ok, offDay: '2026-10-23' })).toMatch(/both days must be Saturdays/);
    expect(swapProblem({ ...ok, workDay: '2026-10-03' })).toMatch(/arranged ahead/);
    expect(swapProblem({ ...ok, workDay: '2026-10-24', offDay: '2026-10-17' })).toMatch(/not Asha's week off/);
    expect(swapProblem({ ...ok, theirs: sideOf('Bilal', ODD) })).toMatch(/Bilal is off on 2026-10-17 too/);
    expect(swapProblem({ ...ok, theirs: sideOf('Bilal', EVEN, new Map([['2026-10-24', 'wfh']])) })).toMatch(/Bilal already has work from home on 2026-10-24/);
  });
  it('the next Saturdays from today (today included when it is one)', () => {
    expect(upcomingSaturdays('2026-10-12', 3)).toEqual(['2026-10-17', '2026-10-24', '2026-10-31']);
    expect(upcomingSaturdays('2026-10-17', 2)).toEqual(['2026-10-17', '2026-10-24']);
  });
  it('an open swap makes both its Saturdays busy for both its people', () => {
    const busy = swapBusyByPerson([{ _id: new Types.ObjectId(), userId: A, swap: { workDay: '2026-10-17', offDay: '2026-10-24', partnerUserId: B, partnerName: 'Bilal', partnerBranch: 'BOM', partnerStatus: 'pending', partnerAt: null, partnerNote: '' } }]);
    expect([...(busy.get(A) ?? new Map())]).toEqual([['2026-10-17', 'swapWork'], ['2026-10-24', 'swapOff']]);
    expect([...(busy.get(B) ?? new Map())]).toEqual([['2026-10-17', 'swapOff'], ['2026-10-24', 'swapWork']]);
  });
});

const swapDoc = (over: Partial<HrLeaveApplicationDoc> = {}, sw: Partial<NonNullable<HrLeaveApplicationDoc['swap']>> = {}): HrLeaveApplicationDoc => ({
  _id: new Types.ObjectId(), userId: A, name: 'Asha', branch: 'BOM', from: '2026-10-17', to: '2026-10-24', dayType: 'full', reason: 'family function',
  status: 'pending', appliedAt: new Date('2026-10-12T05:00:00Z'), decidedBy: '', decidedAt: null, decisionNote: '', markedDays: [], skippedDays: [],
  chain: [], approvals: [], source: 'self', kind: 'swap',
  swap: { workDay: '2026-10-17', offDay: '2026-10-24', partnerUserId: B, partnerName: 'Bilal', partnerBranch: 'BOM', partnerStatus: 'pending', partnerAt: null, partnerNote: '', ...sw },
  ...over,
});

describe('a swap read from each side', () => {
  it('the applicant works the 17th and is off the 24th; the partner the other way round', () => {
    expect(toSwapDto(swapDoc(), A)).toMatchObject({ role: 'applicant', you: { work: '2026-10-17', off: '2026-10-24' }, waitingOn: 'Bilal (swap partner)' });
    expect(toSwapDto(swapDoc(), B)).toMatchObject({ role: 'partner', you: { work: '2026-10-24', off: '2026-10-17' }, partner: { name: 'Bilal' }, applicant: { name: 'Asha' } });
  });
  it('accepted → waits on the FM; decided → on nobody', () => {
    expect(swapWaitingOn(swapDoc({}, { partnerStatus: 'accepted' }))).toBe('Review (FM)');
    expect(swapWaitingOn(swapDoc({ status: 'approved' }, { partnerStatus: 'accepted' }))).toBe('');
  });
});

describe('decision alerts', () => {
  it('a swap approved: both people told their own days', () => {
    const out = decisionAlerts(swapDoc({ status: 'approved' }, { partnerStatus: 'accepted' }));
    expect(out.map((o) => [o.userId, o.alert.title, o.alert.body])).toEqual([
      [A, 'Saturday swap approved', 'You work Sat 17 Oct and are off Sat 24 Oct — Bilal the other way round'],
      [B, 'Saturday swap approved', 'You work Sat 24 Oct and are off Sat 17 Oct — Asha the other way round'],
    ]);
  });
  it('declined by the partner: only the applicant is told', () => {
    const out = decisionAlerts(swapDoc({ status: 'rejected', decidedRole: 'Partner', decisionNote: 'family visiting' }, { partnerStatus: 'declined' }));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ userId: A, alert: { title: 'Saturday swap declined', body: expect.stringMatching(/^Bilal declined the swap.*family visiting/) } });
  });
  it('WFH approved: the days counted as present', () => {
    expect(decisionAlert({ kind: 'wfh', status: 'approved', from: '2026-10-14', to: '2026-10-16', markedDays: ['2026-10-14', '2026-10-15'], decisionNote: '' }))
      .toMatchObject({ title: 'Work from home approved · 2026-10-14 → 2026-10-16', body: '2 days marked work from home — counted as present', context: 'Work from home' });
  });
});

describe('router schemas keep every field (validate() strips unknown keys)', () => {
  it('wfh / swap / respond', () => {
    expect(wfhApplySchema.parse({ from: '2026-10-14', to: '2026-10-15', reason: 'plumber', x: 1 })).toEqual({ from: '2026-10-14', to: '2026-10-15', reason: 'plumber' });
    expect(swapRequestSchema.parse({ workDay: '2026-10-17', offDay: '2026-10-24', partnerUserId: B, reason: 'r' })).toEqual({ workDay: '2026-10-17', offDay: '2026-10-24', partnerUserId: B, reason: 'r' });
    expect(swapRespondSchema.parse({ accept: false, note: 'busy' })).toEqual({ accept: false, note: 'busy' });
    expect(() => swapRespondSchema.parse({ note: 'x' })).toThrow();
  });
});

describe('swapService', () => {
  const emp = { [A]: { userId: A, name: 'Asha', branch: 'BOM', weekOff: ODD }, [B]: { userId: B, name: 'Bilal', branch: 'BOM', weekOff: EVEN }, [C]: { userId: C, name: 'Chirag', branch: 'BOM', weekOff: ODD } } as Record<string, unknown>;
  const user = (id: string, app = true) => ({ _id: new Types.ObjectId(id), first_name: 'x', access: { app }, status: 'active' });
  beforeEach(() => {
    jest.resetAllMocks();
    mockRepo.employeeByUserId.mockImplementation(async (id: string) => emp[id] ?? null);
    mockRepo.overridesOn.mockResolvedValue([]);
    mockRepo.openSwapsTouching.mockResolvedValue([]);
    mockRepo.insertLeaveApplication.mockImplementation(async (d: object) => ({ _id: new Types.ObjectId(), ...d }));
    (crmRepo.getUserById as jest.Mock).mockImplementation(async (id: string) => user(id));
    recordUserAlert.mockResolvedValue(undefined);
    postHr.mockResolvedValue({ posted: true });
    hrBranchCodeFor.mockResolvedValue('BOM');
  });

  it('options: the next Saturdays, off by her rule, busy where something is decided', async () => {
    mockRepo.overridesOn.mockResolvedValue([{ userId: A, day: '2026-10-24', state: 'leave' }]);
    const o = await swapService.options(A);
    expect(o).toMatchObject({ today: '2026-10-12', hasRecord: true, saturdays: 'odd', canSwap: true, why: '' });
    expect(o.upcoming.slice(0, 3)).toEqual([
      { day: '2026-10-17', off: true, busy: '' },
      { day: '2026-10-24', off: false, busy: 'paid leave' },
      { day: '2026-10-31', off: true, busy: '' },
    ]);
  });

  it('options: no alternate-Saturday rule → nothing to swap, said', async () => {
    mockRepo.employeeByUserId.mockResolvedValue({ userId: A, name: 'Asha', branch: 'BOM', weekOff: { days: [0], saturdays: 'none' } });
    expect(await swapService.options(A)).toMatchObject({ canSwap: false, why: expect.stringMatching(/work every Saturday/) });
  });

  it('partners: only branch colleagues off on her working Saturday and working her off one, who use the app', async () => {
    mockRepo.employeesOfBranch.mockResolvedValue([emp[A], emp[B], emp[C]]);
    (crmRepo.listUsers as jest.Mock).mockResolvedValue([user(B)]);
    const { partners } = await swapService.partners(A, '2026-10-17', '2026-10-24');
    expect(partners).toEqual([{ userId: B, name: 'Bilal', position: '' }]);   // Chirag is on Asha's rule — off on the 17th too
  });

  it('partners: a pair that does not fit her own rule is refused with the reason', async () => {
    await expect(swapService.partners(A, '2026-10-24', '2026-10-17')).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/not Asha's week off/) });
  });

  it('request: files the ERP row (kind swap, partner pending) and asks the partner', async () => {
    const dto = await swapService.request(A, { workDay: '2026-10-17', offDay: '2026-10-24', partnerUserId: B, reason: 'family function' });
    const row = mockRepo.insertLeaveApplication.mock.calls[0][0];
    expect(row).toMatchObject({ userId: A, kind: 'swap', status: 'pending', source: 'self', from: '2026-10-17', to: '2026-10-24', dayType: 'full', __v: 0,
      swap: { workDay: '2026-10-17', offDay: '2026-10-24', partnerUserId: B, partnerName: 'Bilal', partnerBranch: 'BOM', partnerStatus: 'pending' } });
    expect(row.chain.map((l: { role: string }) => l.role)).toEqual(['FinanceManager', 'Director', 'Owner']);
    expect(dto).toMatchObject({ role: 'applicant', waitingOn: 'Bilal (swap partner)' });
    expect(recordUserAlert).toHaveBeenCalledWith(B, expect.objectContaining({ title: '🔁 Asha asks to swap Saturdays with you', body: expect.stringMatching(/OFF on Sat 17 Oct and WORK on Sat 24 Oct/) }));
  });

  it('request: a colleague already in a swap on that Saturday is refused', async () => {
    mockRepo.openSwapsTouching.mockResolvedValue([swapDoc({ userId: C, name: 'Chirag' }, { partnerUserId: B, workDay: '2026-10-31', offDay: '2026-10-24' })]);
    await expect(swapService.request(A, { workDay: '2026-10-17', offDay: '2026-10-24', partnerUserId: B, reason: 'r' })).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/Bilal already has another swap on 2026-10-24/) });
    expect(mockRepo.insertLeaveApplication).not.toHaveBeenCalled();
  });

  it('request: another branch, or someone without the app, is refused', async () => {
    mockRepo.employeeByUserId.mockImplementation(async (id: string) => (id === B ? { userId: B, name: 'Bilal', branch: 'AMD', weekOff: EVEN } : emp[id]));
    await expect(swapService.request(A, { workDay: '2026-10-17', offDay: '2026-10-24', partnerUserId: B, reason: 'r' })).rejects.toMatchObject({ message: expect.stringMatching(/own branch/) });
    mockRepo.employeeByUserId.mockImplementation(async (id: string) => emp[id] ?? null);
    (crmRepo.getUserById as jest.Mock).mockImplementation(async (id: string) => user(id, id !== B));
    await expect(swapService.request(A, { workDay: '2026-10-17', offDay: '2026-10-24', partnerUserId: B, reason: 'r' })).rejects.toMatchObject({ message: expect.stringMatching(/does not use the Smart Connect app/) });
  });

  it('respond: the partner accepts — re-checked (its own open row not counted), recorded, the applicant and HR told', async () => {
    const doc = swapDoc();
    mockRepo.getLeaveApplication.mockResolvedValueOnce(doc).mockResolvedValueOnce({ ...doc, swap: { ...doc.swap, partnerStatus: 'accepted' } });
    mockRepo.openSwapsTouching.mockResolvedValue([doc]);
    mockRepo.answerSwap.mockResolvedValue(true);
    const dto = await swapService.respond(B, String(doc._id), { accept: true });
    expect(mockRepo.answerSwap).toHaveBeenCalledWith(String(doc._id), B, expect.objectContaining({ 'swap.partnerStatus': 'accepted' }));
    expect(dto).toMatchObject({ role: 'partner', partnerStatus: 'accepted', waitingOn: 'Review (FM)' });
    expect(recordUserAlert).toHaveBeenCalledWith(A, expect.objectContaining({ title: '🔁 Bilal accepted your Saturday swap' }));
    await new Promise((r) => setImmediate(r));
    expect(postHr).toHaveBeenCalledWith(expect.objectContaining({ branchCode: 'BOM', title: '🔁 Saturday swap · Asha ⇄ Bilal' }));
  });

  it('respond: declining closes it as rejected by the Partner (the sweep tells the applicant)', async () => {
    const doc = swapDoc();
    mockRepo.getLeaveApplication.mockResolvedValue(doc);
    mockRepo.answerSwap.mockResolvedValue(true);
    await swapService.respond(B, String(doc._id), { accept: false, note: 'family visiting' });
    expect(mockRepo.answerSwap).toHaveBeenCalledWith(String(doc._id), B, expect.objectContaining({ status: 'rejected', decidedRole: 'Partner', decisionNote: 'family visiting', 'swap.partnerStatus': 'declined' }));
    expect(recordUserAlert).not.toHaveBeenCalled();
  });

  it('respond: only the partner, only while it waits on them', async () => {
    const doc = swapDoc();
    mockRepo.getLeaveApplication.mockResolvedValue(doc);
    await expect(swapService.respond(C, String(doc._id), { accept: true })).rejects.toMatchObject({ status: 404 });
    mockRepo.getLeaveApplication.mockResolvedValue(swapDoc({}, { partnerStatus: 'accepted' }));
    await expect(swapService.respond(B, String(doc._id), { accept: true })).rejects.toMatchObject({ status: 409 });
  });

  it('cancel: the applicant withdraws; the partner is told', async () => {
    const doc = swapDoc();
    mockRepo.getLeaveApplication.mockResolvedValueOnce(doc).mockResolvedValueOnce({ ...doc, status: 'cancelled' });
    mockRepo.cancelLeaveApplication.mockResolvedValue(true);
    const dto = await swapService.cancel(A, String(doc._id));
    expect(dto.status).toBe('cancelled');
    expect(recordUserAlert).toHaveBeenCalledWith(B, expect.objectContaining({ title: '🔁 Asha withdrew the Saturday swap' }));
  });
});

describe('wfhService.apply', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockRepo.employeeByUserId.mockResolvedValue({ userId: A, name: 'Asha', branch: 'BOM' });
    mockRepo.insertLeaveApplication.mockImplementation(async (d: object) => ({ _id: new Types.ObjectId(), ...d }));
    (crmRepo.getUserById as jest.Mock).mockResolvedValue(null);
    postHr.mockResolvedValue({ posted: true });
  });
  it('files kind wfh in the ERP shape', async () => {
    mockRepo.openLeaveApplications.mockResolvedValue([]);
    const dto = await wfhService.apply(A, { from: '2026-10-14', to: '2026-10-15', reason: 'plumber at home' });
    expect(mockRepo.insertLeaveApplication.mock.calls[0][0]).toMatchObject({ userId: A, kind: 'wfh', status: 'pending', from: '2026-10-14', to: '2026-10-15', dayType: 'full', source: 'self' });
    expect(dto).toMatchObject({ days: 2, status: 'pending', waitingOn: 'Review (FM)' });
  });
  it('one ask per day across leave and WFH', async () => {
    mockRepo.openLeaveApplications.mockResolvedValue([{ from: '2026-10-15', to: '2026-10-16', status: 'pending', kind: 'leave', markedDays: [] }]);
    await expect(wfhService.apply(A, { from: '2026-10-14', to: '2026-10-15', reason: 'r' })).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/pending leave application/) });
  });
  it('no HR record → 422', async () => {
    mockRepo.employeeByUserId.mockResolvedValue(null);
    await expect(wfhService.apply(A, { from: '2026-10-14', to: '2026-10-14', reason: 'r' })).rejects.toMatchObject({ status: 422 });
  });
});
