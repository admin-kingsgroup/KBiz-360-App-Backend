// System-alert channel definitions, shared by the alerts API, the admin visibility routes and the
// external ERP/CRM ingest route. Channel ids match the frontend's pulse channel ids; `grant` uses
// the app's existing access-grant format `${branchCode}-${module}` (see Frontend
// makeAccessFilters.alertOK). `module` uses the frontend ModuleKey vocabulary
// ('accounts' = Finance/KBiz Books, 'crm' = CRM, 'leads' = CRM Alerts: lead → query conversions).
//
// REMOVED 2026-08-19 — 'receivables' (Clients Receivables), 'payables' (Supplier Payables),
// 'bankcash', 'hr' (Attendance), 'acct' (the per-voucher money feed), 'sales' (approved invoice
// PDFs) and 'bookings' (SO/PO/GP + INB deal summaries): 33 channels in all. None of those reports
// is a one-way alert any more — every one posts into a branch GROUP CHAT
// (POST /api/alerts/chat → alerts/reportChat.service), by the room its readers already work in:
// finance reports and attendance → "HQ - <BR> Finance", the money feed → "<BR> - Branch Accounts",
// approved invoices and deals → "<BR> - Ticketing" (flights) or "<BR> - Holidays" (everything
// else), and inter-branch deals → the "INB <desk> A/B" room the two branches share. The channels, their stored events and their PDFs were deleted with
// scripts/purge-alert-channels.js. Do not re-add them here without a matching Frontend release.
// The 'Directors Attendance' channel went with them (owner call): hidden attendance is no longer
// summarised anywhere, which is deliberate — it must never land in a branch group.
export interface AlertChannelDef {
  id: string;
  branchCode: string; // ERP/CRM branch code the channel covers (BOM/AMD/NBO/DAR/FBM)
  module: 'accounts' | 'crm' | 'leads';
  grant: string; // per-user grant string a super-admin assigns
  name: string;
  // Seen by EVERY user who belongs to the branch (CRM user.branch_ids) with no grant needed;
  // company-wide roles (super_admin / company_manager) see every branch. Absent = grant-only.
  branchWide?: boolean;
}

export const ALERT_CHANNELS: AlertChannelDef[] = [
  // Fed live by the KBiz Books ERP backend via POST /api/alerts/ingest.
  { id: 'tk_fin_bom', branchCode: 'BOM', module: 'accounts', grant: 'BOM-accounts', name: 'Finance - BOM' },
  { id: 'tk_fin_amd', branchCode: 'AMD', module: 'accounts', grant: 'AMD-accounts', name: 'Finance - AMD' },
  // Fed live by the CRM backend via POST /api/alerts/ingest.
  { id: 'tk_crm_bom', branchCode: 'BOM', module: 'crm', grant: 'BOM-crm', name: 'CRM - BOM' },
  { id: 'tk_crm_amd', branchCode: 'AMD', module: 'crm', grant: 'AMD-crm', name: 'CRM - AMD' },
  // "CRM Alerts" — a lead converted into a query, posted by the CRM backend (module 'leads') into
  // the QUERY's branch. Branch-wide: everyone in that branch sees it. Kept apart from the
  // grant-only 'crm' pair above, which also carries payment amounts.
  { id: 'tk_lead_bom', branchCode: 'BOM', module: 'leads', grant: 'BOM-leads', name: 'CRM Alerts - BOM', branchWide: true },
  { id: 'tk_lead_amd', branchCode: 'AMD', module: 'leads', grant: 'AMD-leads', name: 'CRM Alerts - AMD', branchWide: true },
  { id: 'tk_lead_nbo', branchCode: 'NBO', module: 'leads', grant: 'NBO-leads', name: 'CRM Alerts - NBO', branchWide: true },
  { id: 'tk_lead_dar', branchCode: 'DAR', module: 'leads', grant: 'DAR-leads', name: 'CRM Alerts - DAR', branchWide: true },
  { id: 'tk_lead_fbm', branchCode: 'FBM', module: 'leads', grant: 'FBM-leads', name: 'CRM Alerts - FBM', branchWide: true },
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

// The grants a user holds by BELONGING to a branch rather than by a super-admin's switch: the
// branch-wide channels of their branches. `branchCodes` null = a company-wide role → every branch.
export function branchWideGrants(branchCodes: string[] | null): string[] {
  const codes = branchCodes === null ? null : new Set(branchCodes.map((c) => c.toUpperCase()));
  return ALERT_CHANNELS.filter((c) => c.branchWide && (codes === null || codes.has(c.branchCode))).map((c) => c.grant);
}

// Channels a user may see: super-admins see every channel; everyone else sees exactly the
// channels their grants name — the ones a super-admin assigned (POST /api/admin/alert-visibility,
// edited from the app's Team & Users screen) plus their branch-wide ones
// (alertGrants.effectiveFor merges the two before calling this).
export function visibleChannelIds(isSuper: boolean, grants: string[]): string[] {
  if (isSuper) return ALERT_CHANNELS.map((c) => c.id);
  const held = new Set(grants || []);
  return ALERT_CHANNELS.filter((c) => held.has(c.grant)).map((c) => c.id);
}
