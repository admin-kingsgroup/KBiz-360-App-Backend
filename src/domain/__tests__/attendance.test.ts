import { autoPunch, canFacePunch, computePresence, facePunch } from '../logic/attendance';
import { distanceMeters } from '../logic/geo';
import type { AttendanceRecord, OfficeGeo } from '../types';

const AMD: OfficeGeo = { lat: 23.0225, lng: 72.5714, radius: 150 };
const empty: AttendanceRecord = { inTime: null, outTime: null, via: null };
const T0 = new Date('2026-06-10T09:00:00Z');
const T1 = new Date('2026-06-10T18:00:00Z');

describe('geofence distance', () => {
  it('point at office → ~0 m (inside radius)', () => {
    expect(distanceMeters({ lat: AMD.lat, lng: AMD.lng }, AMD)).toBeLessThanOrEqual(150);
  });
  it('far point → outside radius', () => {
    expect(distanceMeters({ lat: 19.0760, lng: 72.8777 }, AMD)).toBeGreaterThan(150); // Mumbai vs Ahmedabad
  });
});

describe('computePresence', () => {
  it('Wi-Fi on → present via Wi-Fi (no coords needed)', () => {
    const p = computePresence({ wifiOn: true, coords: null, office: AMD });
    expect(p.present).toBe(true);
    expect(p.viaNow).toBe('Wi-Fi');
  });
  it('inside geofence → present via Geofence', () => {
    const p = computePresence({ wifiOn: false, coords: { lat: AMD.lat, lng: AMD.lng }, office: AMD });
    expect(p.inside).toBe(true);
    expect(p.present).toBe(true);
    expect(p.viaNow).toBe('Geofence');
  });
  it('neither → not present', () => {
    const p = computePresence({ wifiOn: false, coords: { lat: 19.07, lng: 72.87 }, office: AMD });
    expect(p.present).toBe(false);
    expect(p.viaNow).toBe('');
  });
});

describe('autoPunch (primary)', () => {
  it('auto check-IN when present and not yet in', () => {
    const next = autoPunch(empty, true, 'Wi-Fi', T0);
    expect(next).not.toBeNull();
    expect(next!.inTime).toBe(T0);
    expect(next!.via).toBe('Wi-Fi');
  });
  it('auto check-OUT when leaving (present false, in set, out null)', () => {
    const checkedIn: AttendanceRecord = { inTime: T0, outTime: null, via: 'Wi-Fi' };
    const next = autoPunch(checkedIn, false, '', T1);
    expect(next!.outTime).toBe(T1);
  });
  it('no transition when present & already checked in', () => {
    const checkedIn: AttendanceRecord = { inTime: T0, outTime: null, via: 'Geofence' };
    expect(autoPunch(checkedIn, true, 'Geofence', T1)).toBeNull();
  });
  it('via falls back to Auto when present but no signal label', () => {
    expect(autoPunch(empty, true, '', T0)!.via).toBe('Auto');
  });
});

describe('face fallback', () => {
  it('blocked when not at office', () => {
    expect(canFacePunch(false, empty, false)).toBe(false);
  });
  it('allowed when present and not complete', () => {
    expect(canFacePunch(true, empty, false)).toBe(true);
  });
  it('blocked while scanning, and once both punched', () => {
    expect(canFacePunch(true, empty, true)).toBe(false);
    expect(canFacePunch(true, { inTime: T0, outTime: T1, via: 'Face' }, false)).toBe(false);
  });
  it('facePunch records IN then OUT with Face method', () => {
    const afterIn = facePunch(empty, T0);
    expect(afterIn.inTime).toBe(T0);
    expect(afterIn.via).toBe('Face');
    const afterOut = facePunch(afterIn, T1);
    expect(afterOut.outTime).toBe(T1);
  });
});
