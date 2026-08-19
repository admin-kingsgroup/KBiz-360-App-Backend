// Which BRANCH does a puncher's attendance belong to, and what is the wall clock there.
//
// This used to be answered by the alert-channel registry (attendanceChannelForBranch), so it only
// ever resolved BOM and AMD — the two branches with an Attendance channel. Every punch in Nairobi,
// Dar es Salaam, Lubumbashi and the Mumbai hub was silently dropped. The day-close report now goes
// to each branch's group chat, and every branch has one, so the question is simply "which code?".
//
// Resolution stays code → alias → city, for one hard-won reason: real Mumbai staff sit under the
// BOMMB branch doc ("Mumbai Main Branch"), and legacy tenants used MUM. Neither is a branch that
// reports on its own; both are Mumbai.
const BRANCH_CODE_ALIASES: Record<string, string> = { BOMMB: 'BOM', MUM: 'BOM' };
const CITY_TO_BRANCH: Record<string, string> = { mumbai: 'BOM', ahmedabad: 'AMD' };

/** The reporting branch code for a CRM branch doc — '' when it cannot be resolved. */
export function attendanceBranchCode(branch: { code?: string | null; city?: string | null } | null | undefined): string {
  if (!branch) return '';
  const code = String(branch.code ?? '').trim().toUpperCase();
  if (code && !BRANCH_CODE_ALIASES[code]) return code;
  if (BRANCH_CODE_ALIASES[code]) return BRANCH_CODE_ALIASES[code];
  return CITY_TO_BRANCH[String(branch.city ?? '').trim().toLowerCase()] ?? '';
}

/** 'YYYY-MM-DD' for an instant in a given zone (en-CA yields exactly that format). */
export function dayKeyIn(tz: string, at: Date = new Date()): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
  } catch {
    return at.toISOString().slice(0, 10);
  }
}
