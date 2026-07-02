import { Schema, type Model, type Types } from 'mongoose';
import { appDb } from '../connection';

// Per-branch office geofence config. The CRM (`test` db) is READ-ONLY and its branches carry no
// coordinates, so the office location/radius is app-owned data stored in kb360_app, keyed by the
// CRM branch id. An admin sets these (Admin → Office locations); the app fetches the caller's offices
// to drive geofence presence, and the backend validates every punch against them (anti-spoofing).
// A branch can have MORE THAN ONE office (e.g. Bombay HQ + Bombay Operational). Each office is its own
// document (identified by _id). Users are locked to a specific office via the user_offices map; users
// with no explicit assignment fall back to their branch's DEFAULT office (or all of them if none set).
export interface OfficeGeofenceDoc {
  _id: Types.ObjectId;
  branchId: string; // CRM branch id
  tenantId: string | null;
  label: string | null; // office name, e.g. "Head Quarter" / "Operational" (defaults to branch code/name)
  address: string | null; // human street address (geocoded → lat/lng), shown to staff/admins
  lat: number;
  lng: number;
  radius: number; // metres
  wifiSsid: string | null; // informational only — SSID can't be verified server-side
  active: boolean;
  isDefault: boolean; // the office unassigned staff in this branch report to
  updatedBy: string | null; // CRM user id of the admin who last set it
  createdAt: Date;
  updatedAt: Date;
}

const OfficeGeofenceSchema = new Schema<OfficeGeofenceDoc>(
  {
    branchId: { type: String, required: true },
    tenantId: { type: String, default: null },
    label: { type: String, default: null },
    address: { type: String, default: null },
    lat: { type: Number, required: true },
    lng: { type: Number, required: true },
    radius: { type: Number, required: true, default: 150 },
    wifiSsid: { type: String, default: null },
    active: { type: Boolean, default: true },
    isDefault: { type: Boolean, default: false },
    updatedBy: { type: String, default: null },
  },
  { timestamps: true, collection: 'office_geofences' },
);
// NOTE: branchId is NO LONGER unique — a branch may have multiple offices.
OfficeGeofenceSchema.index({ branchId: 1 });
OfficeGeofenceSchema.index({ tenantId: 1 });

let _Office: Model<OfficeGeofenceDoc> | null = null;
export function OfficeGeofenceModel(): Model<OfficeGeofenceDoc> {
  if (!_Office) _Office = appDb().model<OfficeGeofenceDoc>('OfficeGeofence', OfficeGeofenceSchema);
  return _Office;
}

export async function ensureOfficeGeofenceIndexes(): Promise<void> {
  // syncIndexes drops the legacy UNIQUE branchId index (so a branch can hold >1 office) and
  // recreates the current non-unique set. createIndexes alone would not remove the old unique index.
  await OfficeGeofenceModel().syncIndexes();
}
