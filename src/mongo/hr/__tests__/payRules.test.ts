import { daysOf, earnedOf, grossOf, ptExplain, ptForMonth, ptSchedule, recoveryFor, scheduleFor } from '../payRules';

// Parity suite for the ERP's salary arithmetic (employee.rules PT + salaryRegister pro-ration +
// staffLoan schedule). Figures pinned here are the ERP's own — a drift means the payslip in the
// app no longer foots to the salary register.

describe('grossOf / ptSchedule', () => {
  it('gross = basic + hra + other', () => {
    expect(grossOf({ basic: 20000, hra: 8000, otherAllowance: 6000 })).toBe(34000);
  });
  it('Maharashtra: men over 10k pay 200 (300 in Feb); women exempt to 25k', () => {
    const men = ptSchedule({ mode: 'auto', state: 'Maharashtra' }, 'male', 34000);
    expect(men).toMatchObject({ monthly: 200, feb: 300, annual: 200 * 11 + 300, basis: 'slab' });
    const women = ptSchedule({ mode: 'auto', state: 'Maharashtra' }, 'female', 24000);
    expect(women.monthly).toBe(0);
  });
  it('Maharashtra men 7,501–10,000 → 175', () => {
    expect(ptSchedule({ mode: 'auto', state: 'Maharashtra' }, 'male', 9000).monthly).toBe(175);
  });
  it('uncoded state falls back to the keyed manual amount (basis manual)', () => {
    const s = ptSchedule({ mode: 'auto', state: 'Kerala', manualMonthly: 150 }, 'male', 30000);
    expect(s).toMatchObject({ monthly: 150, basis: 'manual' });
  });
  it('mode none → nil', () => {
    expect(ptSchedule({ mode: 'none', state: 'Maharashtra' }, 'male', 50000).monthly).toBe(0);
  });
  it('ptExplain names the slab, ladder and band', () => {
    expect(ptExplain({ mode: 'auto', state: 'Maharashtra' }, 'male', 9000)).toBe('Maharashtra slab · men · gross ₹9,000 is ₹7,501–₹10,000 → ₹175 a month');
  });
});

describe('daysOf / earnedOf / ptForMonth', () => {
  it('payable = calendar − absent − notEmployed; leave stays paid', () => {
    const d = daysOf({ calendarDays: 30, absent: 2, leave: 1, notEmployed: 0, lateMarks: 3, noData: 4 });
    expect(d.payableDays).toBe(28);
    expect(d.presentDays).toBe(27);
    expect(d.lopDays).toBe(2);
    expect(d.noDataDays).toBe(4);
  });
  it('each head pro-rates and rounds on its own, so the columns foot', () => {
    const e = earnedOf({ basic: 20000, hra: 8000, otherAllowance: 5000 }, 28, 30);
    expect(e.basic).toBe(Math.round((20000 * 28) / 30));
    expect(e.total).toBe(e.basic + e.hra + e.otherAllowance);
  });
  it('a full month earns the structure exactly', () => {
    expect(earnedOf({ basic: 20000, hra: 8000, otherAllowance: 5000 }, 30, 30).total).toBe(33000);
  });
  it('February takes the larger PT instalment; nothing earned → nothing deducted', () => {
    const computed = { ptMonthly: 200, ptFebruary: 300 };
    expect(ptForMonth(computed, '2026-09', 30000)).toBe(200);
    expect(ptForMonth(computed, '2026-02', 30000)).toBe(300);
    expect(ptForMonth(computed, '2026-02', 0)).toBe(0);
  });
});

describe('staff-loan schedule', () => {
  const loan = { principal: 12000, instalment: 2000, startMonth: '2026-07', status: 'active' as const };
  it('derives the month movement from the terms', () => {
    // Jul and Aug recovered before Sep → opening 8000, due 2000, closing 6000, 3rd instalment.
    const s = scheduleFor(loan, '2026-09');
    expect(s).toMatchObject({ opening: 8000, due: 2000, closing: 6000, instalmentNo: 3 });
  });
  it('the last instalment is only what is left, and the loan closes itself', () => {
    const s = scheduleFor({ ...loan, principal: 5000 }, '2026-09');
    expect(s.due).toBe(1000);
    expect(s.willClose).toBe(true);
  });
  it('skip months defer, never forgive; paused/closed/ended recover nothing', () => {
    expect(scheduleFor({ ...loan, skipMonths: ['2026-08'] }, '2026-09')).toMatchObject({ opening: 10000, due: 2000 });
    expect(scheduleFor({ ...loan, status: 'paused' }, '2026-09').due).toBe(0);
    expect(scheduleFor({ ...loan, endMonth: '2026-08' }, '2026-09').due).toBe(0);
    expect(scheduleFor(loan, '2026-06').reason).toBe('notStarted');
  });
  it('recoveryFor totals every loan line', () => {
    const r = recoveryFor([loan, { principal: 3000, instalment: 500, startMonth: '2026-09', status: 'active' }], '2026-09');
    expect(r.due).toBe(2500);
    expect(r.lines).toHaveLength(2);
  });
});
