// Which group chat is a branch's home for a given kind of report.
//
// Owner, 2026-11-19: every Travkings branch keeps exactly TWO groups — "Accounts <CODE>" and
// "Operation <CODE>" (e.g. "Accounts BOM", "Operation BOM"). "Accounts <CODE>" is the home of the
// accounts, finance and hr families below; "Operation <CODE>" of ticketing and holidays. Those names
// come FIRST in every family; the older per-desk names after them are still accepted, so a branch
// whose groups have not been renamed yet keeps getting its posts.
//
// The families, all per branch (the INB ones per branch PAIR):
//   'finance'       → "HQ - BOM Finance" … the daily Receivables / Payables / Bank & Cash reports.
//                     The hub's equivalent predates the HQ set and is called "MHUB - Finance Team",
//                     so that shape is accepted too.
//   'hr'            → "HQ - BOM HR" / "BOM - HR Team" / "BOM HR" … attendance: the live check-in /
//                     check-out lines and the day-close summary (owner call, 2026-09-06 — these
//                     lived in the finance groups before; callers fall back there when a branch
//                     has no HR group yet).
//   'accounts'      → "BOM - Branch Accounts" … the live per-voucher money-movement feed.
//   'ticketing'     → "BOM - Ticketing" … approved FLIGHT invoices and their SO/PO/GP deals.
//   'holidays'      → "BOM - Holidays" … every other module's invoices and deals (holiday
//                     packages, hotel, car, visa, insurance, misc).
//   'inb-ticketing' → "INB Ticketing AMD/BOM" … an inter-branch flight deal, in the room the two
//   'inb-holidays'    branches share. Addressed with a PAIR ("BOM/AMD") and matched in EITHER
//                     order, because the group was named in whichever order its creator typed.
//   'tickets'       → "Ticket Support" … every support ticket raised in the ERP or the CRM, with
//                     its screenshots, voice notes and screen recordings (owner, 2026-10-12: "after
//                     raising a bug or error send it in this group so the development team work on
//                     it"). ONE room for the whole company — the branch code is ignored.
//
// Matching is done on the SQUASHED name — lower-cased, every non-alphanumeric removed — so the
// exact spacing and dashes someone typed when creating the group never decide whether a branch
// gets its reports: "HQ-BOM Finance" and "HQ - BOM Finance" are one group. A rename past
// recognition is pinned with REPORT_CHAT_GROUPS.
//
// Deliberately its own module with no imports: the resolver it serves reaches into the chat
// service and the storage layer, and this rule is worth testing without any of that.
export type ReportGroupKind = 'finance' | 'hr' | 'accounts' | 'ticketing' | 'holidays' | 'inb-ticketing' | 'inb-holidays' | 'tickets';

/** The kinds that address one company-wide room instead of a branch's. */
export const isCompanyWideKind = (kind: ReportGroupKind): boolean => kind === 'tickets';

export const squashName = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/** The squashed names a branch's group may carry for this kind of report, most specific first.
 *  `branchCode` is one code — except for the INB kinds, which take the pair "SELLER/BUYER". */
export const reportGroupKeys = (kind: ReportGroupKind, branchCode: string): string[] => {
  if (kind === 'tickets') return ['ticketsupport', 'ticketssupport'];
  if (kind === 'inb-ticketing' || kind === 'inb-holidays') {
    const [a, b] = String(branchCode).split('/').map(squashName);
    if (!a || !b || a === b) return [];
    const desk = kind === 'inb-ticketing' ? 'ticketing' : 'holidays';
    return [`inb${desk}${a}${b}`, `inb${desk}${b}${a}`]; // either order — the pair is unordered
  }
  const c = squashName(branchCode);
  if (!c) return [];
  // The branch's two groups since 2026-11-19 — "Accounts BOM", "Operation BOM".
  const accounts = `accounts${c}`;
  const operation = `operation${c}`;
  switch (kind) {
    case 'accounts': return [accounts, `${c}branchaccounts`];
    case 'ticketing': return [operation, `${c}ticketing`];
    case 'holidays': return [operation, `${c}holidays`];
    // "HQ - BOM HR", "BOM - HR Team", "BOM HR" — every shape a branch HR room gets named in.
    case 'hr': return [accounts, `hq${c}hr`, `${c}hrteam`, `${c}hr`];
    default: return [accounts, `hq${c}finance`, `${c}financeteam`];
  }
};

/** The canonical squashed name for a branch's group of this kind. */
export const reportGroupKey = (kind: ReportGroupKind, branchCode: string): string =>
  reportGroupKeys(kind, branchCode)[0] ?? '';

/** Is `name` the `kind` group of `branchCode`? */
export const isReportGroupFor = (name: string | null | undefined, kind: ReportGroupKind, branchCode: string): boolean =>
  reportGroupKeys(kind, branchCode).includes(squashName(name ?? ''));

/** A word (or an alternation of words) that must appear in a candidate group's name — the cheap
 *  Mongo pre-filter before the exact squashed match runs in JS (a regex built from the branch code
 *  would have to guess the punctuation). Every family's names must pass it: "Accounts BOM" carries
 *  neither "finance" nor "hr", so those families let "accounts" through too. */
export const reportGroupNameHint = (kind: ReportGroupKind): string => {
  switch (kind) {
    case 'accounts': return 'accounts';
    case 'ticketing': return 'ticketing|operation';
    case 'holidays': return 'holidays|operation';
    case 'inb-ticketing': return 'ticketing';
    case 'inb-holidays': return 'holidays';
    case 'hr': return 'hr|accounts';
    case 'tickets': return 'support';
    default: return 'finance|accounts';
  }
};

/** Human wording for the "there is no such group" error. The ERP reads only its "No <kind> group"
 *  start (concernChat noRoom), so the wording after it is free to name the current groups. */
export const reportGroupExpected = (kind: ReportGroupKind, branchCode: string): string => {
  const [a, b] = String(branchCode).split('/');
  switch (kind) {
    case 'ticketing': case 'holidays': return `"Operation ${branchCode}"`;
    case 'inb-ticketing': return `"INB Ticketing ${a}/${b}" (either order)`;
    case 'inb-holidays': return `"INB Holidays ${a}/${b}" (either order)`;
    case 'tickets': return '"Ticket Support"';
    default: return `"Accounts ${branchCode}"`; // accounts, finance, hr
  }
};
