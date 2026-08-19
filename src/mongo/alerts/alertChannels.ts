// System-alert channel definitions, shared by the alerts API, the admin visibility routes and the
// external ERP/CRM ingest route. Channel ids match the frontend's pulse channel ids; `grant` uses
// the app's existing access-grant format `${branchCode}-${module}` (see Frontend
// makeAccessFilters.alertOK). `module` uses the frontend ModuleKey vocabulary
// ('accounts' = Finance/KBiz Books, 'crm' = CRM, 'sales' = ERP sales invoices,
// 'bookings' = SO/PO/GP / INB approval GP summaries).
//
// REMOVED 2026-08-19 — 'receivables' (Clients Receivables), 'payables' (Supplier Payables),
// 'bankcash' (Bank & Cash), 'hr' (BOM/AMD/Directors Attendance) and 'acct' (Accounts — the
// per-voucher money-movement feed, which now posts into "<BR> - Branch Accounts"): 23 channels in
// all. None of those reports is a one-way alert any more — the ERP posts the finance and accounts
// ones and the day-close sweep posts attendance into the branch group chats
// (POST /api/alerts/chat → alerts/reportChat.service). The channels, their stored events and their PDFs were deleted with
// scripts/purge-alert-channels.js. Do not re-add them here without a matching Frontend release.
// The 'Directors Attendance' channel went with them (owner call): hidden attendance is no longer
// summarised anywhere, which is deliberate — it must never land in a branch group.
export interface AlertChannelDef {
  id: string;
  branchCode: string; // ERP/CRM branch code the channel covers (BOM/AMD/NBO/DAR/FBM)
  module: 'accounts' | 'crm' | 'sales' | 'bookings';
  grant: string; // per-user grant string a super-admin assigns
  name: string;
}

export const ALERT_CHANNELS: AlertChannelDef[] = [
  // Fed live by the KBiz Books ERP backend via POST /api/alerts/ingest.
  { id: 'tk_fin_bom', branchCode: 'BOM', module: 'accounts', grant: 'BOM-accounts', name: 'Finance - BOM' },
  { id: 'tk_fin_amd', branchCode: 'AMD', module: 'accounts', grant: 'AMD-accounts', name: 'Finance - AMD' },
  // Fed live by the CRM backend via POST /api/alerts/ingest.
  { id: 'tk_crm_bom', branchCode: 'BOM', module: 'crm', grant: 'BOM-crm', name: 'CRM - BOM' },
  { id: 'tk_crm_amd', branchCode: 'AMD', module: 'crm', grant: 'AMD-crm', name: 'CRM - AMD' },
  // Sales Invoice — the ERP pushes the approved sale invoice PDF here (module 'sales'), one
  // channel per live Books branch. All 5 branches, unlike Finance/CRM which are BOM/AMD only.
  { id: 'tk_si_bom', branchCode: 'BOM', module: 'sales', grant: 'BOM-sales', name: 'Sales Invoice - BOM' },
  { id: 'tk_si_amd', branchCode: 'AMD', module: 'sales', grant: 'AMD-sales', name: 'Sales Invoice - AMD' },
  { id: 'tk_si_nbo', branchCode: 'NBO', module: 'sales', grant: 'NBO-sales', name: 'Sales Invoice - NBO' },
  { id: 'tk_si_dar', branchCode: 'DAR', module: 'sales', grant: 'DAR-sales', name: 'Sales Invoice - DAR' },
  { id: 'tk_si_fbm', branchCode: 'FBM', module: 'sales', grant: 'FBM-sales', name: 'Sales Invoice - FBM' },
  // SO/PO/GP / INB — deal summary (sale · purchase · GP · Link No) on every ERP booking
  // approval and INB deal approval, per branch.
  { id: 'tk_bkg_bom', branchCode: 'BOM', module: 'bookings', grant: 'BOM-bookings', name: 'SO/PO/GP / INB - BOM' },
  { id: 'tk_bkg_amd', branchCode: 'AMD', module: 'bookings', grant: 'AMD-bookings', name: 'SO/PO/GP / INB - AMD' },
  { id: 'tk_bkg_nbo', branchCode: 'NBO', module: 'bookings', grant: 'NBO-bookings', name: 'SO/PO/GP / INB - NBO' },
  { id: 'tk_bkg_dar', branchCode: 'DAR', module: 'bookings', grant: 'DAR-bookings', name: 'SO/PO/GP / INB - DAR' },
  { id: 'tk_bkg_fbm', branchCode: 'FBM', module: 'bookings', grant: 'FBM-bookings', name: 'SO/PO/GP / INB - FBM' },
];

export const ALERT_GRANT_IDS: string[] = ALERT_CHANNELS.map((c) => c.grant);

// Ingest-facing lookup: external systems address a channel by (module, branchCode). The ingest
// route also accepts 'finance' as an alias for 'accounts' and 'sales-invoice' for 'sales'
// (the ERP's own vocabulary).
export function channelForModuleBranch(module: string, branchCode: string): AlertChannelDef | null {
  const mod = module === 'finance' ? 'accounts' : module === 'sales-invoice' ? 'sales' : module;
  return (
    ALERT_CHANNELS.find(
      (c) => c.module === mod && c.branchCode.toLowerCase() === (branchCode ?? '').toLowerCase(),
    ) ?? null
  );
}

// Admin-composed announcements. Not grant-based: each EVENT carries its own recipient userId list
// ('*' = everyone). Supers see the whole channel (their sent history); others only events
// addressed to them. Id must match the frontend's announcements pulse channel.
export const ANNOUNCEMENTS_CHANNEL_ID = 'announcements';

// Personal "User Alerts" — every user has one. Not grant-based: each EVENT carries a single
// recipient (the user it's about), and a user only ever sees their own (see alertService.listFor).
// Fed by the attendance emitter (check-in / check-out) and pushed only to that user.
export const USER_ALERTS_CHANNEL_ID = 'user_alerts';

// Channels a user may see: super-admins see every channel; everyone else sees exactly the
// channels a super-admin granted them (grant strings like "BOM-accounts", assigned via
// POST /api/admin/alert-visibility and edited from the app's Team & Users screen).
export function visibleChannelIds(isSuper: boolean, grants: string[]): string[] {
  if (isSuper) return ALERT_CHANNELS.map((c) => c.id);
  const held = new Set(grants || []);
  return ALERT_CHANNELS.filter((c) => held.has(c.grant)).map((c) => c.id);
}
