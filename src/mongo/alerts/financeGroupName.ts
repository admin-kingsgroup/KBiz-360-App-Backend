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

/** The squashed names a branch's reporting group may carry, most specific first.
 *  "HQ - <CODE> Finance" for the five operating branches; "<CODE> - Finance Team" is the hub's
 *  (MHUB's) equivalent — it predates the HQ set and is where MHUB's own reports belong. */
export const financeGroupKeys = (branchCode: string): string[] => {
  const c = squashName(branchCode);
  return c ? [`hq${c}finance`, `${c}financeteam`] : [];
};

/** The canonical squashed name for a branch's Finance group. */
export const financeGroupKey = (branchCode: string): string => financeGroupKeys(branchCode)[0] ?? '';

/** Is `name` the reporting group of `branchCode`? */
export const isFinanceGroupFor = (name: string | null | undefined, branchCode: string): boolean =>
  financeGroupKeys(branchCode).includes(squashName(name ?? ''));
