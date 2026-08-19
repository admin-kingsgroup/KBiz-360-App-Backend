// Which group chat is a branch's home for a given kind of report.
//
// Two families, both per branch:
//   'finance'  → "HQ - BOM Finance" … the daily Receivables / Payables / Bank & Cash reports and
//                the day-close attendance summary. The hub's equivalent predates the HQ set and
//                is called "MHUB - Finance Team", so that shape is accepted too.
//   'accounts' → "BOM - Branch Accounts" … the live per-voucher money-movement feed (receipts,
//                payments, contra, journals, notes, memos) the ERP posts as vouchers are approved.
//
// Matching is done on the SQUASHED name — lower-cased, every non-alphanumeric removed — so the
// exact spacing and dashes someone typed when creating the group never decide whether a branch
// gets its reports: "HQ-BOM Finance" and "HQ - BOM Finance" are one group. A rename past
// recognition is pinned with REPORT_CHAT_GROUPS.
//
// Deliberately its own module with no imports: the resolver it serves reaches into the chat
// service and the storage layer, and this rule is worth testing without any of that.
export type ReportGroupKind = 'finance' | 'accounts';

export const squashName = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/** The squashed names a branch's group may carry for this kind of report, most specific first. */
export const reportGroupKeys = (kind: ReportGroupKind, branchCode: string): string[] => {
  const c = squashName(branchCode);
  if (!c) return [];
  return kind === 'accounts' ? [`${c}branchaccounts`] : [`hq${c}finance`, `${c}financeteam`];
};

/** The canonical squashed name for a branch's group of this kind. */
export const reportGroupKey = (kind: ReportGroupKind, branchCode: string): string =>
  reportGroupKeys(kind, branchCode)[0] ?? '';

/** Is `name` the `kind` group of `branchCode`? */
export const isReportGroupFor = (name: string | null | undefined, kind: ReportGroupKind, branchCode: string): boolean =>
  reportGroupKeys(kind, branchCode).includes(squashName(name ?? ''));

/** The word that must appear in a candidate group's name — the cheap Mongo pre-filter before
 *  the exact squashed match runs in JS (a regex built from the branch code would have to guess
 *  the punctuation). */
export const reportGroupNameHint = (kind: ReportGroupKind): string => (kind === 'accounts' ? 'accounts' : 'finance');

/** Human wording for the "there is no such group" error. */
export const reportGroupExpected = (kind: ReportGroupKind, branchCode: string): string =>
  kind === 'accounts'
    ? `"${branchCode} - Branch Accounts"`
    : `"HQ - ${branchCode} Finance" or "${branchCode} - Finance Team"`;
