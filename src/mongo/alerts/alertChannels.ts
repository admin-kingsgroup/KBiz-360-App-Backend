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

// Admin-composed announcements. Not grant-based: each EVENT carries its own recipient userId list
// ('*' = everyone). Supers see the whole channel (their sent history); others only events
// addressed to them. Id must match the frontend's announcements pulse channel.
export const ANNOUNCEMENTS_CHANNEL_ID = 'announcements';

export const channelForBranchCode = (code: string | null | undefined): AlertChannelDef | null =>
  ALERT_CHANNELS.find((c) => c.branchCode.toLowerCase() === (code ?? '').toLowerCase()) ?? null;

// Channels a user may see: SUPER-ADMINS ONLY. Per-user grants (alertGrants) are no longer
// honored for visibility — the grant storage/endpoints remain in case channels reopen to staff.
export function visibleChannelIds(isSuper: boolean, _grants: string[]): string[] {
  return isSuper ? ALERT_CHANNELS.map((c) => c.id) : [];
}
