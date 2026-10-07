// The ERP calls the app may make for a user (owner, 2026-10-07: ERP approvals in the app). Mirrors
// the ERP app door's own list (kbiz360-erp-backend src/shared/middleware/appServiceDoor.js) — the
// ERP enforces it too; this copy keeps the app from even trying anything else.
const ID = '[0-9a-fA-F]{24}';
const re = (s: string): RegExp => new RegExp(`^${s}$`);

export const ERP_ALLOW: ReadonlyArray<readonly [string, RegExp]> = [
  ['GET', re('/api/auth/whoami')],
  ['GET', re('/api/app-config/approval\\.(verifyEmails|approveEmails|directorEmails|ownerEmails|dealApproveEmails)')],
  ['GET', re('/api/pending-work/approvals')],
  ['GET', re('/api/vouchers/approvals')],
  ['GET', re('/api/vouchers/approval-counts')],
  ['GET', re(`/api/vouchers/${ID}`)],
  ['GET', re(`/api/vouchers/${ID}/journal`)],
  ['POST', re(`/api/vouchers/${ID}/(review|approve|reject)`)],
  ['GET', re('/api/booking-orders')],
  ['GET', re(`/api/booking-orders/${ID}`)],
  ['GET', re(`/api/booking-orders/${ID}/journal`)],
  ['POST', re(`/api/booking-orders/${ID}/(review|approve|reject)`)],
  ['GET', re('/api/tk/change-requests')],
  ['POST', re(`/api/tk/change-requests/${ID}/act`)],
  ['GET', re('/api/tk/inbox')],
  ['GET', re('/api/credit-facilities/requests')],
  ['GET', re('/api/hr/employees/leave-applications')],
  ['PUT', re(`/api/hr/employees/leave-applications/${ID}/(approve|reject)`)],
  ['GET', re('/api/reconciliation/close/board')],
];

/** `path` is the ERP path ("/api/vouchers/approvals"), without the query string. */
export function isAllowedErpCall(method: string, path: string): boolean {
  const m = String(method || '').toUpperCase();
  const p = String(path || '').replace(/\/+$/, '');
  return ERP_ALLOW.some(([am, rx]) => am === m && rx.test(p));
}
