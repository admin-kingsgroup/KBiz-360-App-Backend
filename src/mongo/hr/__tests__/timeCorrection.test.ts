import {
  branchTimezoneOf, chainOf, freshChain, hhmmIn, LEAVE_CHAIN, orderedTurn, ownerSignatures, signedBy,
  toRegularizationDto, waitingOn, wallClockOf,
} from '../timeCorrection.rules';
import { instantAt } from '../attendanceMonth';
import { leaveClash } from '../leave.service';
import { decisionAlert } from '../leaveDecision.sweep';

// A time correction asked in the app is the ERP's own kind-'time' row — these pin the parity the
// ERP relies on (leaveApplication.service / approvalEngine are the originals; this is the port).

const AT = new Date('2026-10-03T09:00:00Z');

describe('the branch clock', () => {
  it('reads the branch master timezone first, then its country, then the default', () => {
    expect(branchTimezoneOf({ timezone: 'Africa/Nairobi', countryCode: 'IN' }, 'Asia/Kolkata')).toBe('Africa/Nairobi');
    expect(branchTimezoneOf({ timezone: 'Not/AZone', countryCode: 'TZ' }, 'Asia/Kolkata')).toBe('Africa/Dar_es_Salaam');
    expect(branchTimezoneOf({ countryCode: 'CD' }, 'Asia/Kolkata')).toBe('Africa/Lubumbashi');
    expect(branchTimezoneOf(null, 'Asia/Kolkata')).toBe('Asia/Kolkata');
    expect(branchTimezoneOf({ countryCode: 'ZZ' }, 'Asia/Kolkata')).toBe('Asia/Kolkata');
  });

  it('writes HH:MM on the branch clock and reads it back to the same instant', () => {
    // 04:10Z = 09:40 IST = 07:10 Nairobi.
    const inAt = new Date('2026-09-05T04:10:00.000Z');
    expect(hhmmIn('Asia/Kolkata', inAt)).toBe('09:40');
    expect(hhmmIn('Africa/Nairobi', inAt)).toBe('07:10');
    expect(instantAt('2026-09-05', hhmmIn('Asia/Kolkata', inAt), 'Asia/Kolkata')?.toISOString()).toBe(inAt.toISOString());
    expect(instantAt('2026-09-05', hhmmIn('Africa/Nairobi', inAt), 'Africa/Nairobi')?.toISOString()).toBe(inAt.toISOString());
  });

  it('renders the midnight hour as 00, never 24', () => {
    // 18:30Z = 00:00 IST the next day — the h24 cycle would print "24:00".
    expect(hhmmIn('Asia/Kolkata', new Date('2026-09-05T18:30:00.000Z'))).toBe('00:00');
  });

  it('wallClockOf leaves an open check-out blank, as the ERP keys it', () => {
    expect(wallClockOf({ checkInAt: new Date('2026-09-05T04:10:00.000Z'), checkOutAt: null }, 'Asia/Kolkata')).toEqual({ checkIn: '09:40', checkOut: '' });
    expect(wallClockOf({ checkInAt: new Date('2026-09-05T04:10:00.000Z'), checkOutAt: new Date('2026-09-05T13:00:00.000Z') }, 'Asia/Kolkata')).toEqual({ checkIn: '09:40', checkOut: '18:30' });
  });
});

describe('the chain', () => {
  it('is FM → Director → Owner, and a row from before reads the standing chain', () => {
    expect(freshChain()).toEqual([
      { order: 1, role: 'FinanceManager', label: 'Review (FM)' },
      { order: 2, role: 'Director', label: 'Confirm (Director)' },
      { order: 3, role: 'Owner', label: 'Approve (Owner)' },
    ]);
    expect(chainOf({})).toEqual(freshChain());
    expect(chainOf({ chain: [{ order: 1, role: 'Owner', label: 'Only' }] })).toEqual([{ order: 1, role: 'Owner', label: 'Only' }]);
    expect(freshChain()).not.toBe(LEAVE_CHAIN); // a copy — the row stamps its own
  });

  it('says whose turn it is', () => {
    expect(waitingOn({})).toBe('Review (FM)');
    expect(waitingOn({ approvals: [{ role: 'FinanceManager', by: 'fm', at: AT }] })).toBe('Confirm (Director)');
    expect(waitingOn({ approvals: [{ role: 'FinanceManager', by: 'fm', at: AT }, { role: 'Director', by: 'd', at: AT }, { role: 'Owner', by: 'o', at: AT }] })).toBe('');
    expect(signedBy({ approvals: [{ role: 'FinanceManager', by: 'fm', at: AT }, { role: 'Director', by: 'o', at: AT, skipped: true }] })).toEqual(['FM']);
  });

  it('orderedTurn: a senior may sign past, a junior may not sign ahead, nobody signs twice', () => {
    const chain = freshChain();
    expect(orderedTurn(chain, [], 'Owner')).toMatchObject({ allowed: true, past: [{ role: 'FinanceManager' }, { role: 'Director' }] });
    expect(orderedTurn(chain, [{ role: 'FinanceManager', by: 'fm', at: AT }], 'Owner').past.map((l) => l.role)).toEqual(['Director']);
    expect(orderedTurn(chain, [{ role: 'FinanceManager', by: 'fm', at: AT }], 'FinanceManager').allowed).toBe(false);
    // A level signed past is recorded as `skipped` — so it reads as signed and cannot sign again.
    expect(orderedTurn(chain, [{ role: 'FinanceManager', by: 'd', at: AT, skipped: true }, { role: 'Director', by: 'd', at: AT }], 'FinanceManager').allowed).toBe(false);
    expect(orderedTurn(chain, [], 'BranchManager').allowed).toBe(false);
  });

  it('an in-app approval is the Owner signing past the levels not yet signed, with the reason on each', () => {
    const sigs = ownerSignatures({ approvals: [{ role: 'FinanceManager', by: 'fm@x', at: AT }] }, { by: 'owner@x', at: AT, note: 'ok', reason: 'in the app' });
    expect(sigs).toEqual([
      { role: 'Director', by: 'owner@x', at: AT, skipped: true, signedPastBy: 'Owner', reason: 'in the app' },
      { role: 'Owner', by: 'owner@x', at: AT, note: 'ok' },
    ]);
    // Every level already signed → nothing to add (the row could not still be pending).
    expect(ownerSignatures({ approvals: [{ role: 'Owner', by: 'o', at: AT }] }, { by: 'o', reason: 'x' })).toBeNull();
  });
});

describe('the DTO the app screens read', () => {
  const row = {
    _id: 'abc', userId: 'u1', name: 'Faiz', branch: 'BOM', from: '2026-09-05', reason: 'forgot', status: 'pending',
    appliedAt: new Date('2026-09-05T10:00:00Z'), decidedBy: '', decidedAt: null, decisionNote: '', checkIn: '09:40', checkOut: '',
    approvals: [{ role: 'FinanceManager', by: 'fm', at: AT }],
  };

  it('turns HH:MM on the branch clock back into instants and carries where the chain stands', () => {
    const dto = toRegularizationDto(row, 'Asia/Kolkata');
    expect(dto).toMatchObject({ id: 'abc', userId: 'u1', date: '2026-09-05', checkInAt: '2026-09-05T04:10:00.000Z', checkOutAt: null, status: 'pending', name: 'Faiz', branch: 'BOM' });
    expect(dto.decidedBy).toBeNull();
    expect(dto.waitingOn).toBe('Confirm (Director)');
    expect(dto.signedBy).toEqual(['FM']);
  });

  it('a decided row carries no chain fields and names who decided it', () => {
    const dto = toRegularizationDto({ ...row, status: 'approved', decidedBy: 'owner@x', decidedAt: AT, checkOut: '18:30' }, 'Asia/Kolkata');
    expect(dto.waitingOn).toBeUndefined();
    expect(dto.decidedBy).toBe('owner@x');
    expect(dto.checkOutAt).toBe('2026-09-05T13:00:00.000Z');
  });

  it('explicit name/branch win over the denormalised ones', () => {
    expect(toRegularizationDto(row, 'Asia/Kolkata', { name: 'Faiz K', branch: 'AMD' })).toMatchObject({ name: 'Faiz K', branch: 'AMD' });
  });
});

describe('leaveClash — the ERP overlap rule', () => {
  const pending = { from: '2026-09-10', to: '2026-09-12', status: 'pending' };
  const approved = { from: '2026-09-01', to: '2026-09-05', status: 'approved', markedDays: ['2026-09-01', '2026-09-02'] };
  it('a pending span blocks every day in it; an approved one only the days it marked', () => {
    expect(leaveClash([pending, approved], { from: '2026-09-12', to: '2026-09-13' })).toBe(pending);
    expect(leaveClash([pending, approved], { from: '2026-09-02', to: '2026-09-02' })).toBe(approved);
    expect(leaveClash([pending, approved], { from: '2026-09-04', to: '2026-09-05' })).toBeNull(); // skipped days are free
    expect(leaveClash([], { from: '2026-09-04', to: '2026-09-05' })).toBeNull();
  });
});

describe('decisionAlert — what the requester is told, by kind', () => {
  it('names a time correction and its times', () => {
    const a = decisionAlert({ kind: 'time', status: 'approved', from: '2026-09-05', to: '2026-09-05', markedDays: ['2026-09-05'], decisionNote: '', checkIn: '09:40', checkOut: '18:30', toStatus: '' });
    expect(a.title).toBe('Time correction approved · 2026-09-05');
    expect(a.body).toContain('in 09:40 · out 18:30');
    expect(a.source).toBe('Attendance');
    expect(decisionAlert({ kind: 'time', status: 'rejected', from: '2026-09-05', to: '2026-09-05', markedDays: [], decisionNote: 'no', checkIn: '09:40', checkOut: '', toStatus: '' }).body).toBe('in 09:40 · out left open · no');
  });
  it('keeps the leave wording a row from before got', () => {
    const a = decisionAlert({ kind: undefined, status: 'approved', from: '2026-09-10', to: '2026-09-12', markedDays: ['2026-09-10', '2026-09-11'], decisionNote: 'enjoy', checkIn: '', checkOut: '', toStatus: '' });
    expect(a).toEqual({ source: 'HR', title: 'Leave approved', body: '2026-09-10 → 2026-09-12 · 2 days marked · enjoy', context: 'Your leave' });
  });
  it('says what a leave removal turned the day into', () => {
    expect(decisionAlert({ kind: 'cancel', status: 'approved', from: '2026-09-10', to: '2026-09-10', markedDays: [], decisionNote: '', checkIn: '', checkOut: '', toStatus: 'absent' }).body).toBe('2026-09-10 is no longer paid leave — it is now absent');
  });
});
