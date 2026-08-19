// System-alert channel definitions, shared by the alerts API, the admin visibility routes and the
// external ERP/CRM ingest route. Channel ids match the frontend's pulse channel ids; `grant` uses
// the app's existing access-grant format `${branchCode}-${module}` (see Frontend
// makeAccessFilters.alertOK). `module` uses the frontend ModuleKey vocabulary
// ('accounts' = Finance/KBiz Books, 'crm' = CRM — the only two families left here).
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
  module: 'accounts' | 'crm';
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
