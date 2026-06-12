// Time formatter used on attendance cards. Extracted from fmt() (FacePunchSheet variant
// returns null for empty; AttendanceScreen variant returns '—'). Caller chooses the empty token.
export function fmtTime(d: Date | null, empty: string | null = null): string | null {
  return d ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : empty;
}
