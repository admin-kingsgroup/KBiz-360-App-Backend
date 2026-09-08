// Pay arithmetic for one month's payslip — FAITHFUL PORTS of the ERP's pure rules:
//   • employee.rules.js — grossOf, the PT slab table, ptSchedule, ptExplain
//   • salaryRegister.service.js — daysOf, earnedOf, ptForMonth
//   • staffLoan.rules.js — instalmentsBefore, scheduleFor, recoveryFor
// The salary register on the ERP is the source of truth; a payslip here must foot to the same
// figures. Change the ERP and this port in the same breath.

const num = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const str = (v: unknown): string => (v == null ? '' : String(v).trim());
const rupee = (n: number): number => Math.round(num(n));
const money = (n: number): number => Math.round((Number(n) || 0) * 100) / 100;

// ── Professional Tax slabs (statutory; data, so amount and explanation share one source) ──
interface PtBand { upTo?: number; monthly: number; feb?: number }
interface PtSlab { label: string; all: PtBand[]; female?: PtBand[] }
const TG_AP: PtBand[] = [{ upTo: 15000, monthly: 0 }, { upTo: 20000, monthly: 150 }, { monthly: 200 }];
const PT_SLABS: Record<string, PtSlab> = {
  MAHARASHTRA: {
    label: 'Maharashtra',
    female: [{ upTo: 25000, monthly: 0 }, { monthly: 200, feb: 300 }],
    all: [{ upTo: 7500, monthly: 0 }, { upTo: 10000, monthly: 175 }, { monthly: 200, feb: 300 }],
  },
  GUJARAT: { label: 'Gujarat', all: [{ upTo: 12000, monthly: 0 }, { monthly: 200 }] },
  KARNATAKA: { label: 'Karnataka', all: [{ upTo: 25000, monthly: 0 }, { monthly: 200, feb: 300 }] },
  'WEST BENGAL': {
    label: 'West Bengal',
    all: [{ upTo: 10000, monthly: 0 }, { upTo: 15000, monthly: 110 }, { upTo: 25000, monthly: 130 }, { upTo: 40000, monthly: 150 }, { monthly: 200 }],
  },
  TELANGANA: { label: 'Telangana', all: TG_AP },
  'ANDHRA PRADESH': { label: 'Andhra Pradesh', all: TG_AP },
  'TAMIL NADU': {
    label: 'Tamil Nadu',
    all: [{ upTo: 21000, monthly: 0 }, { upTo: 30000, monthly: 22.5 }, { upTo: 45000, monthly: 52.5 }, { upTo: 60000, monthly: 115 }, { upTo: 75000, monthly: 171 }, { monthly: 208.5 }],
  },
};

const ptLadder = (slab: PtSlab, gender: string): PtBand[] =>
  (str(gender).toLowerCase() === 'female' && slab.female) ? slab.female : slab.all;

function ptBandOf(slab: PtSlab, gender: string, gross: number): { band: Required<Pick<PtBand, 'monthly' | 'feb'>> & PtBand; index: number; ladder: PtBand[]; gendered: boolean } {
  const ladder = ptLadder(slab, gender);
  const g = num(gross);
  const index = ladder.findIndex((b) => b.upTo == null || g <= b.upTo);
  const i = index === -1 ? ladder.length - 1 : index;
  const band = ladder[i];
  return { band: { ...band, feb: band.feb == null ? band.monthly : band.feb }, index: i, ladder, gendered: ladder === slab.female };
}

const ptStateKey = (s: string): string => str(s).toUpperCase();
const hasPtSlab = (state: string): boolean => Object.prototype.hasOwnProperty.call(PT_SLABS, ptStateKey(state));

/** Pure: Basic + HRA + Other Allowance — the monthly gross. */
export function grossOf(salary: { basic?: number; hra?: number; otherAllowance?: number } = {}): number {
  return num(salary.basic) + num(salary.hra) + num(salary.otherAllowance);
}

export interface PtInput { mode?: string; state?: string; manualMonthly?: number }

/** Pure: the PT schedule for one employee (ERP employee.rules.ptSchedule). */
export function ptSchedule({ mode = 'auto', state = '', manualMonthly = 0 }: PtInput = {}, gender = '', gross = 0): { monthly: number; feb: number; annual: number; basis: string; state: string; stateLabel?: string } {
  const st = ptStateKey(state);
  if (mode === 'none') return { monthly: 0, feb: 0, annual: 0, basis: 'none', state: st };
  if (mode === 'auto' && hasPtSlab(st)) {
    const slab = PT_SLABS[st];
    const { band } = ptBandOf(slab, gender, gross);
    return { monthly: band.monthly, feb: band.feb, annual: band.monthly * 11 + band.feb, basis: 'slab', state: st, stateLabel: slab.label };
  }
  const m = Math.max(0, num(manualMonthly));
  return { monthly: m, feb: m, annual: m * 12, basis: 'manual', state: st, stateLabel: (PT_SLABS[st] && PT_SLABS[st].label) || str(state) };
}

/** Pure: WHY the PT is what it is, in one line (ERP employee.rules.ptExplain). */
export function ptExplain({ mode = 'auto', state = '', manualMonthly = 0 }: PtInput = {}, gender = '', gross = 0): string {
  const st = ptStateKey(state);
  const rupees = (n: number): string => `₹${Number(n || 0).toLocaleString('en-IN')}`;
  if (mode === 'none') return 'Professional Tax is not applicable to this record';
  if (mode === 'manual' || !hasPtSlab(st)) {
    const m = Math.max(0, num(manualMonthly));
    const why = mode === 'manual' ? 'keyed by hand on the HR record'
      : st ? `${str(state)} has no coded slab, so the amount is keyed by hand`
        : 'no state on the record, so the amount is keyed by hand';
    return `${rupees(m)} a month — ${why}`;
  }
  const slab = PT_SLABS[st];
  const { band, index, ladder, gendered } = ptBandOf(slab, gender, gross);
  const prev = index > 0 ? ladder[index - 1].upTo ?? null : null;
  const where = band.upTo == null
    ? `is above ${rupees(prev ?? 0)}`
    : prev == null ? `is up to ${rupees(band.upTo)}` : `is ${rupees(prev + 1)}–${rupees(band.upTo)}`;
  const who = slab.female ? ` · ${gendered ? 'women' : 'men'}` : '';
  const feb = band.feb !== band.monthly ? ` (${rupees(band.feb ?? band.monthly)} in February)` : '';
  return `${slab.label} slab${who} · gross ${rupees(gross)} ${where} → ${rupees(band.monthly)} a month${feb}`;
}

// ── The month's day columns + pro-rated earnings (ERP salaryRegister.service) ──

export interface PayDays {
  calendarDays: number; absentDays: number; leaveDays: number; notEmployedDays: number;
  lateMarks: number; noDataDays: number; payableDays: number; presentDays: number; lopDays: number;
}

export function daysOf(summary: { calendarDays?: number; absent?: number; leave?: number; notEmployed?: number; lateMarks?: number; noData?: number } = {}): PayDays {
  const calendarDays = num(summary.calendarDays);
  const absentDays = num(summary.absent);
  const leaveDays = num(summary.leave);
  const notEmployedDays = num(summary.notEmployed);
  const payableDays = Math.max(0, calendarDays - absentDays - notEmployedDays);
  return {
    calendarDays, absentDays, leaveDays, notEmployedDays,
    lateMarks: num(summary.lateMarks),
    noDataDays: num(summary.noData),
    payableDays,
    presentDays: Math.max(0, payableDays - leaveDays),
    lopDays: absentDays,
  };
}

/** Pure: what each salary head EARNS for the payable days — each head pro-rated and rounded on
 *  its own, then added, so the columns always foot to the total. */
export function earnedOf(salary: { basic?: number; hra?: number; otherAllowance?: number } = {}, payableDays: number, calendarDays: number): { basic: number; hra: number; otherAllowance: number; total: number } {
  const share = (amount: unknown): number => {
    const full = num(amount);
    if (!calendarDays || payableDays >= calendarDays) return rupee(full);
    if (payableDays <= 0) return 0;
    return rupee((full * payableDays) / calendarDays);
  };
  const basic = share(salary.basic);
  const hra = share(salary.hra);
  const otherAllowance = share(salary.otherAllowance);
  return { basic, hra, otherAllowance, total: basic + hra + otherAllowance };
}

/** Pure: the PT for THIS month — February takes the larger instalment. Nothing earned → nothing deducted. */
export function ptForMonth(computed: { ptMonthly?: number; ptFebruary?: number | null } = {}, month = '', earnedTotal = 0): number {
  if (earnedTotal <= 0) return 0;
  const isFebruary = String(month).slice(5, 7) === '02';
  const feb = computed.ptFebruary == null ? computed.ptMonthly : computed.ptFebruary;
  return Math.max(0, num(isFebruary ? feb : computed.ptMonthly));
}

// ── Staff-loan schedule (ERP staffLoan.rules — derived, never keyed monthly) ──

export interface LoanTerms {
  id?: string; kind?: string; reference?: string; status?: string;
  principal?: number; instalment?: number; openingRecovered?: number; waived?: number;
  startMonth?: string; endMonth?: string; skipMonths?: string[];
}

const LOAN_MONTH_RE = /^\d{4}-\d{2}$/;
const isMonth = (v: unknown): boolean => LOAN_MONTH_RE.test(str(v));
const loanMonthIndex = (key: string): number => { const [y, m] = String(key).slice(0, 7).split('-').map(Number); return y * 12 + (m - 1); };
const recoverable = (l: LoanTerms): number => Math.max(0, money(num(l.principal) - num(l.waived)));

function instalmentsBefore(l: LoanTerms, month: string): number {
  if (!isMonth(month) || !isMonth(l.startMonth)) return 0;
  const elapsed = loanMonthIndex(month) - loanMonthIndex(l.startMonth as string);
  if (elapsed <= 0) return 0;
  const skipped = (l.skipMonths || []).filter((m) => m >= (l.startMonth as string) && m < month).length;
  return Math.max(0, elapsed - skipped);
}

export function scheduleFor(l: LoanTerms, month: string): { opening: number; due: number; closing: number; instalmentNo: number; recoveredBefore: number; willClose: boolean; reason: string } {
  const lent = recoverable(l);
  const recoveredBefore = Math.min(lent, money(num(l.openingRecovered) + instalmentsBefore(l, month) * num(l.instalment)));
  const opening = money(lent - recoveredBefore);
  const blank = (reason: string) => ({ opening, due: 0, closing: opening, instalmentNo: 0, recoveredBefore, willClose: false, reason });
  if (!isMonth(month) || !isMonth(l.startMonth)) return blank('noSchedule');
  if (l.status === 'closed') return blank('closed');
  if (l.status === 'paused') return blank('paused');
  if (month < (l.startMonth as string)) return blank('notStarted');
  if (l.endMonth && month > l.endMonth) return blank('ended');
  if ((l.skipMonths || []).includes(month)) return blank('skipped');
  if (opening <= 0) return blank('settled');
  const due = money(Math.min(num(l.instalment), opening));
  const closing = money(opening - due);
  return { opening, due, closing, instalmentNo: instalmentsBefore(l, month) + 1, recoveredBefore, willClose: closing <= 0, reason: '' };
}

export interface LoanRecoveryLine {
  id: string; kind: string; reference: string; principal: number; instalment: number; status: string;
  opening: number; due: number; closing: number; instalmentNo: number; willClose: boolean; reason: string;
}

export function recoveryFor(loans: LoanTerms[] = [], month = ''): { lines: LoanRecoveryLine[]; due: number; opening: number; closing: number } {
  const lines = (Array.isArray(loans) ? loans : []).map((l) => {
    const s = scheduleFor(l, month);
    return {
      id: String(l.id || ''), kind: l.kind || 'loan', reference: l.reference || '',
      principal: money(num(l.principal)), instalment: money(num(l.instalment)), status: l.status || 'active',
      opening: s.opening, due: s.due, closing: s.closing,
      instalmentNo: s.instalmentNo, willClose: s.willClose, reason: s.reason,
    };
  });
  return {
    lines,
    due: money(lines.reduce((n, x) => n + x.due, 0)),
    opening: money(lines.reduce((n, x) => n + x.opening, 0)),
    closing: money(lines.reduce((n, x) => n + x.closing, 0)),
  };
}

export { rupee, money, num as numOf };
