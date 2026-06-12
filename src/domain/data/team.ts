import { colors } from '../theme/colors';

// Team attendance dashboard data (Super Admin only). Copied verbatim from source teamAttendance.
export interface TeamMember { id: string; name: string; initials: string; color: string; branch: string; in: string | null; out: string | null; via: string | null; }

export const teamAttendance: TeamMember[] = [
  { id: 't1', name: 'Farhan Aga', initials: 'FA', color: colors.purple, branch: 'TK AMD', in: '9:01 AM', out: null, via: 'Wi-Fi' },
  { id: 't2', name: 'Faiz Khan', initials: 'FK', color: colors.orange, branch: 'TK AMD', in: '8:58 AM', out: null, via: 'Geofence' },
  { id: 't3', name: 'Mehul Raj', initials: 'MR', color: colors.blue, branch: 'TK AMD', in: '9:14 AM', out: null, via: 'Wi-Fi' },
  { id: 't4', name: 'Riya Patel', initials: 'RP', color: colors.teal, branch: 'TK AMD', in: null, out: null, via: null },
  { id: 't5', name: 'Sanjay Nair', initials: 'SN', color: colors.coral, branch: 'TK BOM', in: '9:22 AM', out: null, via: 'Geofence' },
  { id: 't6', name: 'Karen Owino', initials: 'KO', color: '#6D6D72', branch: 'TK NBO', in: '8:46 AM', out: null, via: 'Wi-Fi' },
  { id: 't7', name: 'Anjali Sharma', initials: 'AS', color: colors.success, branch: 'TK BOM', in: null, out: null, via: null },
];
