import { Schema, type Model, type Types } from 'mongoose';
import { appDb } from '../connection';

// One attendance row per user per day (UTC day key). The device decides presence (geofence/Wi-Fi/
// Face) and posts the punch; the backend persists it and serves today's status + a team view.
export interface AttendanceDoc {
  _id: Types.ObjectId;
  userId: string; // CRM user id
  dateKey: string; // 'YYYY-MM-DD' (UTC) — daily uniqueness
  date: Date;
  checkInAt: Date | null;
  checkOutAt: Date | null;
  method: string | null; // 'Wi-Fi' | 'Geofence' | 'Face' | 'Auto' | 'Manual' (admin correction)
  present: boolean;
  latitude: number | null;
  longitude: number | null;
  distanceMeters: number | null;
  wifiSsid: string | null;
  faceVerified: boolean | null;
  checkInPhotoUrl: string | null; // face photo captured at check-in (owner rules, 07-31)
  checkOutPhotoUrl: string | null; // face photo captured at check-out
  adjustedBy: string | null; // admin user id when the day was manually corrected
  adjustedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const AttendanceSchema = new Schema<AttendanceDoc>(
  {
    userId: { type: String, required: true },
    dateKey: { type: String, required: true },
    date: { type: Date, required: true },
    checkInAt: { type: Date, default: null },
    checkOutAt: { type: Date, default: null },
    method: { type: String, default: null },
    present: { type: Boolean, default: false },
    latitude: { type: Number, default: null },
    longitude: { type: Number, default: null },
    distanceMeters: { type: Number, default: null },
    wifiSsid: { type: String, default: null },
    faceVerified: { type: Boolean, default: null },
    checkInPhotoUrl: { type: String, default: null },
    checkOutPhotoUrl: { type: String, default: null },
    adjustedBy: { type: String, default: null },
    adjustedAt: { type: Date, default: null },
  },
  { timestamps: true, collection: 'attendance' },
);
AttendanceSchema.index({ userId: 1, dateKey: 1 }, { unique: true });
AttendanceSchema.index({ dateKey: 1 });

let _Attendance: Model<AttendanceDoc> | null = null;
export function AttendanceModel(): Model<AttendanceDoc> {
  if (!_Attendance) _Attendance = appDb().model<AttendanceDoc>('Attendance', AttendanceSchema);
  return _Attendance;
}

export async function ensureAttendanceIndexes(): Promise<void> {
  await AttendanceModel().createIndexes();
}
