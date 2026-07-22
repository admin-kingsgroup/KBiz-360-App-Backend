// System-alert channel definitions, shared by the alerts API, the admin visibility routes, the
// attendance emitter and the external ERP/CRM ingest route. Channel ids match the frontend's pulse
// channel ids; `grant` uses the app's existing access-grant format `${branchCode}-${module}` (see
// Frontend makeAccessFilters.alertOK). `module` uses the frontend ModuleKey vocabulary
// ('hr' = attendance, 'accounts' = Finance/KBiz Books, 'crm' = CRM, 'sales' = ERP sales invoices,
// 'receivables' = Clients Receivables / Onboarding, 'payables' = Supplier Payables / Onboarding).
export interface AlertChannelDef {
  id: string;
  branchCode: string; // ERP/CRM branch code the channel covers (BOM/AMD/NBO/DAR/FBM)
  module: 'hr' | 'accounts' | 'crm' | 'sales' | 'receivables' | 'payables';
  grant: string; // per-user grant string a super-admin assigns
  name: string;
}

export const ALERT_CHANNELS: AlertChannelDef[] = [
  { id: 'tk_att_bom', branchCode: 'BOM', module: 'hr', grant: 'BOM-hr', name: 'BOM Attendance' },
  { id: 'tk_att_amd', branchCode: 'AMD', module: 'hr', grant: 'AMD-hr', name: 'AMD Attendance' },
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
  // Clients Receivables / Onboarding — the ERP's daily 11:00 IST Receivables "Ageing & Settlement"
  // PDF (plus the weekly overdue nudge) lands here per branch.
  { id: 'tk_ar_bom', branchCode: 'BOM', module: 'receivables', grant: 'BOM-receivables', name: 'Clients Receivables - BOM' },
  { id: 'tk_ar_amd', branchCode: 'AMD', module: 'receivables', grant: 'AMD-receivables', name: 'Clients Receivables - AMD' },
  { id: 'tk_ar_nbo', branchCode: 'NBO', module: 'receivables', grant: 'NBO-receivables', name: 'Clients Receivables - NBO' },
  { id: 'tk_ar_dar', branchCode: 'DAR', module: 'receivables', grant: 'DAR-receivables', name: 'Clients Receivables - DAR' },
  { id: 'tk_ar_fbm', branchCode: 'FBM', module: 'receivables', grant: 'FBM-receivables', name: 'Clients Receivables - FBM' },
  // Supplier Payables / Onboarding — the ERP's daily Payables "Ageing & Settlement" PDF per branch.
  { id: 'tk_ap_bom', branchCode: 'BOM', module: 'payables', grant: 'BOM-payables', name: 'Supplier Payables - BOM' },
  { id: 'tk_ap_amd', branchCode: 'AMD', module: 'payables', grant: 'AMD-payables', name: 'Supplier Payables - AMD' },
  { id: 'tk_ap_nbo', branchCode: 'NBO', module: 'payables', grant: 'NBO-payables', name: 'Supplier Payables - NBO' },
  { id: 'tk_ap_dar', branchCode: 'DAR', module: 'payables', grant: 'DAR-payables', name: 'Supplier Payables - DAR' },
  { id: 'tk_ap_fbm', branchCode: 'FBM', module: 'payables', grant: 'FBM-payables', name: 'Supplier Payables - FBM' },
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

// Attendance-emitter lookup: a branch's ATTENDANCE channel (there are now several channels per
// branch, so this must filter by module, not just branch).
export const channelForBranchCode = (code: string | null | undefined): AlertChannelDef | null =>
  ALERT_CHANNELS.find((c) => c.module === 'hr' && c.branchCode.toLowerCase() === (code ?? '').toLowerCase()) ?? null;

// Real branch docs don't always carry the channel's code — Mumbai staff sit under BOMMB
// ("Mumbai Main Branch", the ERP's head-office branch) and legacy tenants used MUM — so
// resolve exact code → alias → city. Without this, every BOMMB puncher was silently
// skipped and the attendance channels stayed empty forever.
const BRANCH_CODE_ALIASES: Record<string, string> = { BOMMB: 'BOM', MUM: 'BOM' };
const CITY_TO_CHANNEL_BRANCH: Record<string, string> = { mumbai: 'BOM', ahmedabad: 'AMD' };
export function attendanceChannelForBranch(branch: { code?: string | null; city?: string | null } | null | undefined): AlertChannelDef | null {
  if (!branch) return null;
  const code = String(branch.code ?? '').toUpperCase();
  return (
    channelForBranchCode(code)
    ?? channelForBranchCode(BRANCH_CODE_ALIASES[code] ?? null)
    ?? channelForBranchCode(CITY_TO_CHANNEL_BRANCH[String(branch.city ?? '').trim().toLowerCase()] ?? null)
  );
}

// Channels a user may see: super-admins see every channel; everyone else sees exactly the
// channels a super-admin granted them (grant strings like "BOM-accounts", assigned via
// POST /api/admin/alert-visibility and edited from the app's Team & Users screen).
export function visibleChannelIds(isSuper: boolean, grants: string[]): string[] {
  if (isSuper) return ALERT_CHANNELS.map((c) => c.id);
  const held = new Set(grants || []);
  return ALERT_CHANNELS.filter((c) => held.has(c.grant)).map((c) => c.id);
}
