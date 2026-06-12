import type { Permissions } from '../types';

export type PermKey = keyof Permissions;

// Order + copy copied verbatim from source PERMISSIONS (location, network, notifications).
export interface PermissionMeta { key: PermKey; iconName: 'navigation' | 'wifi' | 'bell'; color: string; title: string; desc: string; }

export const PERMISSIONS: PermissionMeta[] = [
  { key: 'location',      iconName: 'navigation', color: '#22C55E', title: 'Location · Always',     desc: 'Geofence auto check-in / check-out at the office.' },
  { key: 'network',       iconName: 'wifi',       color: '#4F8BFF', title: 'Local network / Wi-Fi', desc: 'Detect the office router for auto check-in.' },
  { key: 'notifications', iconName: 'bell',       color: '#E8A13A', title: 'Notifications',         desc: 'Reminders, system alerts and attendance confirmations.' },
];
