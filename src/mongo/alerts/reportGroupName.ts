// Which group chat is a branch's home for a given kind of report.
//
// The families, all per branch (the INB ones per branch PAIR):
//   'finance'       → "HQ - BOM Finance" … the daily Receivables / Payables / Bank & Cash reports
//                     and the day-close attendance summary. The hub's equivalent predates the HQ
//                     set and is called "MHUB - Finance Team", so that shape is accepted too.
//   'accounts'      → "BOM - Branch Accounts" … the live per-voucher money-movement feed.
//   'ticketing'     → "BOM - Ticketing" … approved FLIGHT invoices and their SO/PO/GP deals.
//   'holidays'      → "BOM - Holidays" … every other module's invoices and deals (holiday
//                     packages, hotel, car, visa, insurance, misc).
//   'inb-ticketing' → "INB Ticketing AMD/BOM" … an inter-branch flight deal, in the room the two
//   'inb-holidays'    branches share. Addressed with a PAIR ("BOM/AMD") and matched in EITHER
//                     order, because the group was named in whichever order its creator typed.
//
// Matching is done on the SQUASHED name — lower-cased, every non-alphanumeric removed — so the
// exact spacing and dashes someone typed when creating the group never decide whether a branch
// gets its reports: "HQ-BOM Finance" and "HQ - BOM Finance" are one group. A rename past
// recognition is pinned with REPORT_CHAT_GROUPS.
//
// Deliberately its own module with no imports: the resolver it serves reaches into the chat
// service and the storage layer, and this rule is worth testing without any of that.
export type ReportGroupKind = 'finance' | 'accounts' | 'ticketing' | 'holidays' | 'inb-ticketing' | 'inb-holidays';

export const squashName = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/** The squashed names a branch's group may carry for this kind of report, most specific first.
 *  `branchCode` is one code — except for the INB kinds, which take the pair "SELLER/BUYER". */
export const reportGroupKeys = (kind: ReportGroupKind, branchCode: string): string[] => {
  if (kind === 'inb-ticketing' || kind === 'inb-holidays') {
    const [a, b] = String(branchCode).split('/').map(squashName);
    if (!a || !b || a === b) return [];
    const desk = kind === 'inb-ticketing' ? 'ticketing' : 'holidays';
    return [`inb${desk}${a}${b}`, `inb${desk}${b}${a}`]; // either order — the pair is unordered
  }
  const c = squashName(branchCode);
  if (!c) return [];
  switch (kind) {
    case 'accounts': return [`${c}branchaccounts`];
    case 'ticketing': return [`${c}ticketing`];
    case 'holidays': return [`${c}holidays`];
    default: return [`hq${c}finance`, `${c}financeteam`];
  }
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
export const reportGroupNameHint = (kind: ReportGroupKind): string => {
  switch (kind) {
    case 'accounts': return 'accounts';
    case 'ticketing': case 'inb-ticketing': return 'ticketing';
    case 'holidays': case 'inb-holidays': return 'holidays';
    default: return 'finance';
  }
};

/** Human wording for the "there is no such group" error. */
export const reportGroupExpected = (kind: ReportGroupKind, branchCode: string): string => {
  const [a, b] = String(branchCode).split('/');
  switch (kind) {
    case 'accounts': return `"${branchCode} - Branch Accounts"`;
    case 'ticketing': return `"${branchCode} - Ticketing"`;
    case 'holidays': return `"${branchCode} - Holidays"`;
    case 'inb-ticketing': return `"INB Ticketing ${a}/${b}" (either order)`;
    case 'inb-holidays': return `"INB Holidays ${a}/${b}" (either order)`;
    default: return `"HQ - ${branchCode} Finance" or "${branchCode} - Finance Team"`;
  }
};
