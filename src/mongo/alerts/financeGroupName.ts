// Which group chat is "the Finance group" for a branch.
//
// The five branch finance groups are named "HQ - BOM Finance", "HQ - AMD Finance", … (created
// under the MHUB hub branch). Matching is done on the SQUASHED name — lower-cased, every
// non-alphanumeric removed — so the exact spacing and dashes a person typed when the group was
// created never decide whether a branch gets its daily reports: "HQ-BOM Finance",
// "HQ - BOM Finance" and "HQ  -  BOM  Finance" are one group. A rename that keeps those letters
// keeps working; a rename past recognition is pinned with REPORT_CHAT_GROUPS.
//
// Deliberately its own module with no imports: the resolver it serves reaches into the chat
// service and the storage layer, and this rule is worth testing without any of that.
export const squashName = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/** The squashed name the branch's Finance group must have. */
export const financeGroupKey = (branchCode: string): string => `hq${squashName(branchCode)}finance`;

/** Is `name` the Finance group of `branchCode`? */
export const isFinanceGroupFor = (name: string | null | undefined, branchCode: string): boolean =>
  !!branchCode.trim() && squashName(name ?? '') === financeGroupKey(branchCode);
