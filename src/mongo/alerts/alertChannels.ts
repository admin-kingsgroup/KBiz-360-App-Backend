// System-alert channel definitions, shared by the alerts API, the admin visibility routes and the
// external ERP/CRM ingest route. Channel ids match the frontend's pulse channel ids; `grant` uses
// the app's existing access-grant format `${branchCode}-${module}` (see Frontend
// makeAccessFilters.alertOK). `module` uses the frontend ModuleKey vocabulary
// ('accounts' = legacy Finance, 'crm' = legacy CRM Payments, 'attendance' = HR, 'leads' = CRM,
// 'erp' = ERP, 'crm-reports' = CRM Reports, 'erp-reports' = ERP Reports).
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
//
// REVERSED 2026-09-27 (owner: "stop that and send in this alert"): those feeds are alerts again,
// regrouped as HR / ERP / ERP Reports below, and the group chats no longer receive them. The
// retired ids and grant keys above stay retired — the new families use fresh ones.
export interface AlertChannelDef {
  id: string;
  branchCode: string; // ERP/CRM branch code the channel covers (BOM/AMD/NBO/DAR/FBM/MHUB)
  module: 'accounts' | 'crm' | 'leads' | 'attendance' | 'erp' | 'erp-reports' | 'crm-reports';
  grant: string; // per-user grant string a super-admin assigns
  name: string;
  // Seen by EVERY user who belongs to the branch (CRM user.branch_ids) with no grant needed;
  // company-wide roles (super_admin / company_manager) see every branch. Absent = grant-only.
  branchWide?: boolean;
}

// The Alerts section's groups, in the order the app shows them (owner, 2026-09-27):
//   HR · CRM · ERP · CRM Reports · ERP Reports — one channel per branch in each.
// HR / ERP / ERP Reports carry money or colleagues' hours, so they are GRANT-ONLY (supers + the
// people a super-admin switches on in Team & Users). CRM / CRM Reports are BRANCH-WIDE.
const HR_ERP_BRANCHES = ['BOM', 'AMD', 'NBO', 'DAR', 'FBM', 'MHUB'];
const CRM_BRANCHES = ['BOM', 'AMD', 'NBO', 'DAR', 'FBM'];
const family = (
  prefix: string, module: AlertChannelDef['module'], label: string, codes: string[], branchWide = false,
): AlertChannelDef[] => codes.map((code) => ({
  id: `${prefix}_${code.toLowerCase()}`, branchCode: code, module, grant: `${code}-${module}`,
  name: `${label} - ${code}`, ...(branchWide ? { branchWide: true } : {}),
}));

export const ALERT_CHANNELS: AlertChannelDef[] = [
  // LEGACY, hidden in the app. Finance: the old KBiz Books voucher feed. CRM Payments: fed by the
  // CRM backend (module 'crm') — payments submitted/verified, ERP pushes, refund/reissue cases.
  { id: 'tk_fin_bom', branchCode: 'BOM', module: 'accounts', grant: 'BOM-accounts', name: 'Finance - BOM' },
  { id: 'tk_fin_amd', branchCode: 'AMD', module: 'accounts', grant: 'AMD-accounts', name: 'Finance - AMD' },
  { id: 'tk_crm_bom', branchCode: 'BOM', module: 'crm', grant: 'BOM-crm', name: 'CRM Payments - BOM' },
  { id: 'tk_crm_amd', branchCode: 'AMD', module: 'crm', grant: 'AMD-crm', name: 'CRM Payments - AMD' },
  // HR — attendance: each check-in / check-out line and the 10 PM day-close summary, written by
  // this backend's attendance service (they used to post into the branch HR / Finance group).
  ...family('tk_hr', 'attendance', 'HR', HR_ERP_BRANCHES),
  // CRM — a lead converted into a query, posted by the CRM backend (module 'leads') into the
  // QUERY's branch. (Ids keep the 'lead' name it launched with as "CRM Alerts".)
  ...family('tk_lead', 'leads', 'CRM', CRM_BRANCHES, true),
  // ERP — live KBiz Books events (module 'erp'): approved-booking invoice PDFs, deal summaries
  // (a hub deal lands in BOTH branches), and every posted money voucher. They used to post into
  // "<BR> - Ticketing" / "<BR> - Holidays" / "<BR> - Branch Accounts" / the "Hub … A/B" rooms.
  ...family('tk_erp', 'erp', 'ERP', HR_ERP_BRANCHES),
  // CRM Reports — the CRM's daily 11:00 branch-local Query Ageing PDF (module 'crm-reports').
  ...family('tk_crmrep', 'crm-reports', 'CRM Reports', CRM_BRANCHES, true),
  // ERP Reports — the ERP's daily 11:00 branch-local Receivables / Payables ageing and Bank & Cash
  // PDFs plus the weekly 61+ overdue nudge (module 'erp-reports'); they used to post into
  // "HQ - <BR> Finance".
  ...family('tk_erprep', 'erp-reports', 'ERP Reports', HR_ERP_BRANCHES),
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
