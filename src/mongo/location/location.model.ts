import { Schema, type Model, type Types } from 'mongoose';
import { appDb } from '../connection';

// Work-hours location trail. The device streams GPS fixes ONLY while the person's attendance day
// is open (checked in, not yet checked out) — the server refuses anything else (location.service
// ingest). One document per accepted fix; the admin "Live location" screen reads a per-user
// LAST-KNOWN row (location_last, upserted on every batch) for the roster and the full day's
// points (location_pings) for the trail map. Retention is bounded by a TTL on `at`
// (LOCATION_TRAIL_TTL_DAYS, default 90) — the collection can never grow without limit.
export interface LocationPingDoc {
  _id: Types.ObjectId;
  userId: string; // CRM user id
  tenantId: string | null;
  dateKey: string; // 'YYYY-MM-DD' business-tz day of the OPEN attendance record the fix belongs to
  at: Date; // device timestamp of the fix
  lat: number;
  lng: number;
  accuracy: number | null; // metres (68% radius) as reported by the OS; null when unknown
  speed: number | null; // m/s
  heading: number | null; // degrees
  altitude: number | null; // metres
  source: 'bg' | 'fg'; // background location-updates task vs a foreground one-shot fix
  createdAt: Date;
}

const LocationPingSchema = new Schema<LocationPingDoc>(
  {
    userId: { type: String, required: true },
    tenantId: { type: String, default: null },
    dateKey: { type: String, required: true },
    at: { type: Date, required: true },
    lat: { type: Number, required: true },
    lng: { type: Number, required: true },
    accuracy: { type: Number, default: null },
    speed: { type: Number, default: null },
    heading: { type: Number, default: null },
    altitude: { type: Number, default: null },
    source: { type: String, default: 'bg' },
  },
  { timestamps: { createdAt: true, updatedAt: false }, collection: 'location_pings' },
);
// Trail read: one user, one day, in time order. The unique pair also makes batch re-sends
// (a device retrying after a dropped response) idempotent — duplicates are skipped, not doubled.
LocationPingSchema.index({ userId: 1, at: 1 }, { unique: true });
LocationPingSchema.index({ userId: 1, dateKey: 1 });

export const LOCATION_TRAIL_TTL_DAYS = Math.max(1, Number(process.env.LOCATION_TRAIL_TTL_DAYS ?? 90) || 90);
LocationPingSchema.index({ at: 1 }, { expireAfterSeconds: LOCATION_TRAIL_TTL_DAYS * 24 * 3600 });

// Last-known position per user — what the live roster reads (one row per person, not a scan of
// the day's pings). Kept even after check-out so the admin sees "last seen at 18:42".
export interface LocationLastDoc {
  _id: Types.ObjectId;
  userId: string;
  tenantId: string | null;
  dateKey: string;
  at: Date;
  lat: number;
  lng: number;
  accuracy: number | null;
  updatedAt: Date;
}

const LocationLastSchema = new Schema<LocationLastDoc>(
  {
    userId: { type: String, required: true },
    tenantId: { type: String, default: null },
    dateKey: { type: String, required: true },
    at: { type: Date, required: true },
    lat: { type: Number, required: true },
    lng: { type: Number, required: true },
    accuracy: { type: Number, default: null },
  },
  { timestamps: { createdAt: false, updatedAt: true }, collection: 'location_last' },
);
LocationLastSchema.index({ userId: 1 }, { unique: true });

let _Ping: Model<LocationPingDoc> | null = null;
export function LocationPingModel(): Model<LocationPingDoc> {
  if (!_Ping) _Ping = appDb().model<LocationPingDoc>('LocationPing', LocationPingSchema);
  return _Ping;
}

let _Last: Model<LocationLastDoc> | null = null;
export function LocationLastModel(): Model<LocationLastDoc> {
  if (!_Last) _Last = appDb().model<LocationLastDoc>('LocationLast', LocationLastSchema);
  return _Last;
}

export async function ensureLocationIndexes(): Promise<void> {
  // syncIndexes so a changed TTL (env) replaces the old expiry index instead of erroring.
  await LocationPingModel().syncIndexes();
  await LocationLastModel().syncIndexes();
}
