export type PunchMethod = 'Wi-Fi' | 'Geofence' | 'Face' | 'Auto';

export interface AttendanceRecord {
  inTime: Date | null;
  outTime: Date | null;
  via: PunchMethod | null;
}

export interface OfficeGeo {
  lat: number;
  lng: number;
  radius: number;
}

export interface Coords {
  lat: number;
  lng: number;
}

export interface OfficePresence {
  distance: number | null;
  inside: boolean;
  present: boolean;
  viaNow: '' | 'Wi-Fi' | 'Geofence';
}

export interface TeamAttendanceEntry {
  id: string;
  name: string;
  initials: string;
  color: string;
  branch: string;
  in: string | null;
  out: string | null;
  via?: PunchMethod;
}
