// The ERP calls the app may make for a user (owner, 2026-10-07: ERP approvals in the app). Mirrors
// the ERP app door's own list (kbiz360-erp-backend src/shared/middleware/appServiceDoor.js) — the
// ERP enforces it too; this copy keeps the app from even trying anything else.
const ID = '[0-9a-fA-F]{24}';
const re = (s: string): RegExp => new RegExp(`^${s}$`);

type Query = Record<string, unknown>;
export const ERP_ALLOW: ReadonlyArray<readonly [string, RegExp, ((query: Query) => boolean)?]> = [
  ['GET', re('/api/auth/whoami')],
  ['GET', re('/api/app-config/approval\\.(verifyEmails|approveEmails|directorEmails|ownerEmails|dealApproveEmails)')],
  ['GET', re('/api/pending-work/approvals')],
  ['GET', re('/api/vouchers/approvals')],
  ['GET', re('/api/vouchers/approval-counts')],
  // Approvals ▸ Entries ▸ Edits for FM (2026-11-18): the list only. Reviewing and deciding an edit stays in the ERP.
  ['GET', re('/api/vouchers/edit-requests')],
  ['GET', re(`/api/vouchers/${ID}`)],
  ['GET', re(`/api/vouchers/${ID}/journal`)],
  ['POST', re(`/api/vouchers/${ID}/(review|approve|reject)`)],
  ['GET', re('/api/booking-orders')],
  ['GET', re(`/api/booking-orders/${ID}`)],
  ['GET', re(`/api/booking-orders/${ID}/journal`)],
  ['POST', re(`/api/booking-orders/${ID}/(review|approve|reject)`)],
  ['GET', re('/api/tk/change-requests')],
  ['POST', re(`/api/tk/change-requests/${ID}/act`)],
  // Approvals ▸ Payables (owner, 2026-10-09): re-run / close an approved payment request that did not apply (the ERP lets
  // only the Owner / Super Admin) and the recently approved list beside it.
  ['POST', re(`/api/tk/change-requests/${ID}/(retry|close)`)],
  ['GET', re('/api/payment-requests')],
  ['GET', re('/api/tk/inbox')],
  ['GET', re('/api/credit-facilities/requests')],
  ['GET', re('/api/hr/employees/leave-applications')],
  ['PUT', re(`/api/hr/employees/leave-applications/${ID}/(approve|reject)`)],
  ['GET', re('/api/reconciliation/close/board')],
  // The Owner's Review in the app and on its home-screen widget (owner, 2026-10-30): what the Director approved, READ only.
  ['GET', re('/api/ba-dashboard/owner/director-decided')],
  // The ERP's eight Approvals tabs in the app (2026-11-18), read only: Status (and, of the audit trail, only its recorded list),
  // Raise & Resolve's lists and ERP Concerns (never one concern: opening it marks it Seen), the payables tiles, the Pairs count.
  ['GET', re('/api/pending-work/approvals/status')],
  ['GET', re('/api/tk/monitor/audit'), (query) => query.recorded === '1'],
  ['GET', re('/api/concerns/(mine|erp)')],
  ['GET', re('/api/operations-board/cashplan')],
  ['GET', re('/api/hub-deal/approval-counts')],
];

/** `path` is the ERP path ("/api/vouchers/approvals"), without the query string. */
export function isAllowedErpCall(method: string, path: string, query: Query = {}): boolean {
  const m = String(method || '').toUpperCase();
  const p = String(path || '').replace(/\/+$/, '');
  return ERP_ALLOW.some(([am, rx, queryOk]) => am === m && rx.test(p) && (!queryOk || queryOk(query)));
}
