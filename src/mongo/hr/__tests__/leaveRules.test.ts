import {
  addMonths,
  leaveBalance,
  leaveEligibleFrom,
  shiftDay,
  spanDays,
  spansOverlap,
  validateApplication,
  LEAVE_ACCRUAL_FROM,
  MAX_SPAN_DAYS,
} from '../leaveRules';

// Parity suite for the ERP's employee.rules.js leave math + leaveApplication.service.js bounds.
// The scenarios (and expected figures) mirror the ERP's own semantics — if one of these fails
// after an edit, the two backends have diverged on someone's balance.

describe('leaveEligibleFrom', () => {
  it('joined on the 1st → credited from the next month', () => {
    expect(leaveEligibleFrom('2026-07-01')).toBe('2026-08');
  });
  it('joined mid-month → the month after next', () => {
    expect(leaveEligibleFrom('2026-07-17')).toBe('2026-09');
  });
  it('no DOJ → "" (policy start applies)', () => {
    expect(leaveEligibleFrom('')).toBe('');
    expect(leaveEligibleFrom('garbage')).toBe('');
  });
});

describe('addMonths', () => {
  it('rolls years and accepts day keys', () => {
    expect(addMonths('2026-12', 1)).toBe('2027-01');
    expect(addMonths('2026-07-17', 1)).toBe('2026-08');
    expect(addMonths('2026-01', -1)).toBe('2025-12');
  });
});

describe('leaveBalance', () => {
  const base = { openingBalance: 7, openingAsOf: '2026-07', monthlyAccrual: 2.5, dateOfJoining: '2024-01-01' };

  it('opening + monthly credits − taken, as at the end of the as-of month', () => {
    // Opening 7 as at Jul close; accrual from Aug; as at Sep end → 2 months credited = 5.
    const b = leaveBalance({ ...base, asOf: '2026-09-15', leaveDays: ['2026-08-12', '2026-09-03'] });
    expect(b.accrualFrom).toBe('2026-08');
    expect(b.creditedMonths).toBe(2);
    expect(b.accrued).toBe(5);
    expect(b.taken).toBe(2);
    expect(b.balance).toBe(10);
    expect(b.nextCreditOn).toBe('2026-10-01');
  });

  it('leave days in or before the opening month are already inside the keyed figure', () => {
    const b = leaveBalance({ ...base, asOf: '2026-09-15', leaveDays: ['2026-07-10', '2026-08-12'] });
    expect(b.takenDays).toEqual(['2026-08-12']);
    expect(b.taken).toBe(1);
  });

  it('leave days after the as-of month do not draw down yet', () => {
    const b = leaveBalance({ ...base, asOf: '2026-08-05', leaveDays: ['2026-08-20', '2026-09-02'] });
    // A leave later in the SAME month is already spoken for; next month's is not.
    expect(b.takenDays).toEqual(['2026-08-20']);
  });

  it('nothing credited before the policy start or before eligibility', () => {
    const b = leaveBalance({ openingBalance: 0, openingAsOf: '', dateOfJoining: '2026-08-17', asOf: '2026-09-30' });
    expect(b.eligibleFrom).toBe('2026-10');
    expect(b.accrualFrom).toBe('2026-10'); // later of policy start (2026-08) and eligibility
    expect(b.creditedMonths).toBe(0);
    expect(b.balance).toBe(0);
  });

  it('credits stop at the leaving month and nextCreditOn empties after it', () => {
    const b = leaveBalance({ ...base, dateOfLeaving: '2026-09-10', asOf: '2026-11-30' });
    expect(b.creditedMonths).toBe(2); // Aug + Sep
    expect(b.nextCreditOn).toBe('');
  });

  it('missing accrual reads as the 2.5 default; explicit 0 is honoured', () => {
    expect(leaveBalance({ ...base, monthlyAccrual: undefined, asOf: '2026-08-31' }).monthlyAccrual).toBe(2.5);
    expect(leaveBalance({ ...base, monthlyAccrual: 0, asOf: '2026-08-31' }).accrued).toBe(0);
  });

  it('duplicate and malformed leave days are dropped', () => {
    const b = leaveBalance({ ...base, asOf: '2026-09-30', leaveDays: ['2026-08-12', '2026-08-12', 'not-a-day'] });
    expect(b.taken).toBe(1);
  });

  it('weighted entries: a worked half-day draws 0.5, keys and entries mix, one per day', () => {
    const b = leaveBalance({ ...base, asOf: '2026-09-30', leaveDays: ['2026-08-12', { day: '2026-09-03', weight: 0.5 }, { day: '2026-09-03', weight: 1 }] });
    expect(b.taken).toBe(1.5);
    expect(b.takenDays).toEqual(['2026-08-12', '2026-09-03']);
    expect(b.balance).toBe(7 + 5 - 1.5);
  });

  it('policy start default matches the ERP', () => {
    expect(LEAVE_ACCRUAL_FROM).toBe('2026-08');
  });
});

describe('spanDays / spansOverlap / shiftDay', () => {
  it('inclusive span; malformed or reversed → []', () => {
    expect(spanDays('2026-09-01', '2026-09-03')).toEqual(['2026-09-01', '2026-09-02', '2026-09-03']);
    expect(spanDays('2026-09-03', '2026-09-01')).toEqual([]);
    expect(spanDays('nope', '2026-09-01')).toEqual([]);
  });
  it('crosses month ends', () => {
    expect(shiftDay('2026-08-31', 1)).toBe('2026-09-01');
    expect(shiftDay('2026-09-01', -1)).toBe('2026-08-31');
  });
  it('overlap is share-a-day', () => {
    expect(spansOverlap({ from: '2026-09-01', to: '2026-09-05' }, { from: '2026-09-05', to: '2026-09-09' })).toBe(true);
    expect(spansOverlap({ from: '2026-09-01', to: '2026-09-05' }, { from: '2026-09-06', to: '2026-09-09' })).toBe(false);
  });
});

describe('validateApplication', () => {
  const today = '2026-09-08';
  it('normalises and returns the span', () => {
    const a = validateApplication({ from: ' 2026-09-10 ', to: '2026-09-11', reason: '  family function  ' }, { today });
    expect(a).toMatchObject({ from: '2026-09-10', to: '2026-09-11', reason: 'family function' });
    expect(a.days).toHaveLength(2);
  });
  it('refuses bad dates, reversed spans, missing reason', () => {
    expect(() => validateApplication({ from: 'x', to: '2026-09-11', reason: 'r' }, { today })).toThrow(/From must be/);
    expect(() => validateApplication({ from: '2026-09-12', to: '2026-09-11', reason: 'r' }, { today })).toThrow(/before From/);
    expect(() => validateApplication({ from: '2026-09-10', to: '2026-09-11', reason: '  ' }, { today })).toThrow(/Say why/);
  });
  it('dayType: defaults full; half must be one day', () => {
    expect(validateApplication({ from: '2026-09-10', to: '2026-09-10', reason: 'r', dayType: 'half' }, { today }).dayType).toBe('half');
    expect(validateApplication({ from: '2026-09-10', to: '2026-09-11', reason: 'r' }, { today }).dayType).toBe('full');
    expect(() => validateApplication({ from: '2026-09-10', to: '2026-09-11', reason: 'r', dayType: 'half' }, { today })).toThrow(/half-day is one day/i);
  });
  it('caps the span at 31 days and bounds the reach', () => {
    expect(() => validateApplication({ from: '2026-09-01', to: '2026-10-05', reason: 'r' }, { today })).toThrow(new RegExp(`${MAX_SPAN_DAYS} days`));
    expect(() => validateApplication({ from: '2026-06-01', to: '2026-06-02', reason: 'r' }, { today })).toThrow(/too far back/);
    expect(() => validateApplication({ from: '2027-09-20', to: '2027-09-21', reason: 'r' }, { today })).toThrow(/more than a year ahead/);
  });
});
