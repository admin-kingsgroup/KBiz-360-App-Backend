// System-alert channel definitions, shared by the alerts API, the admin visibility routes and the
// attendance emitter. Channel ids match the frontend's pulse channel ids; `grant` uses the app's
// existing access-grant format `${branchCode}-${module}` (see Frontend makeAccessFilters.alertOK).
export interface AlertChannelDef {
  id: string;
  branchCode: string; // CRM branch code the channel covers (AMD/BOM)
  grant: string; // per-user grant string a super-admin assigns
  name: string;
}

export const ALERT_CHANNELS: AlertChannelDef[] = [
  { id: 'tk_att_bom', branchCode: 'BOM', grant: 'BOM-hr', name: 'BOM Attendance' },
  { id: 'tk_att_amd', branchCode: 'AMD', grant: 'AMD-hr', name: 'AMD Attendance' },
];

export const ALERT_GRANT_IDS: string[] = ALERT_CHANNELS.map((c) => c.grant);

export const channelForBranchCode = (code: string | null | undefined): AlertChannelDef | null =>
  ALERT_CHANNELS.find((c) => c.branchCode.toLowerCase() === (code ?? '').toLowerCase()) ?? null;

// Channels a user may see: super-admins see all; others need the channel's grant (or a
// module-wide 'hr' grant).
export function visibleChannelIds(isSuper: boolean, grants: string[]): string[] {
  if (isSuper) return ALERT_CHANNELS.map((c) => c.id);
  return ALERT_CHANNELS.filter((c) => grants.includes(c.grant) || grants.includes('hr')).map((c) => c.id);
}
