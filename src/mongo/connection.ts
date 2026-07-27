import mongoose, { type Connection } from 'mongoose';
import { config } from '../config';

// Connections to the Atlas cluster:
//   • base (MONGODB_URI) → app writes on appDb(); CRM READS on crmDb(). Least-privilege target:
//     readWrite on kb360_app, READ-ONLY on the CRM db (see DB_LEAST_PRIVILEGE.md). The read-only
//     boundary is also enforced in code by crm.repo's read-only guard.
//   • crmWrite (CRM_WRITE_MONGODB_URI, optional) → the ONLY sanctioned path for the handful of CRM
//     provisioning writes. Unset ⇒ those writes fall back to `base` (backward compatible).
let base: Connection | null = null;
let crmWrite: Connection | null = null;

export async function connectMongo(): Promise<Connection> {
  if (base && base.readyState === 1) return base;
  if (!config.mongo.uri) throw new Error('MONGODB_URI not set');
  await mongoose.connect(config.mongo.uri, { serverSelectionTimeoutMS: 10000 });
  base = mongoose.connection;
  if (config.mongo.crmWriteUri) {
    crmWrite = await mongoose
      .createConnection(config.mongo.crmWriteUri, { serverSelectionTimeoutMS: 10000 })
      .asPromise();
  }
  return base;
}

// CRM READ handle. The app treats the CRM as read-only; crm.repo wraps this in a write-guard.
export function crmDb(): Connection {
  if (!base) throw new Error('Mongo not connected — call connectMongo() first');
  return base.useDb(config.mongo.crmDb, { useCache: true });
}

// CRM WRITE handle — used ONLY by crm.repo's sanctioned provisioning writes. Uses the dedicated
// least-privilege write connection when configured, else falls back to `base`.
export function crmWriteDb(): Connection {
  const conn = crmWrite ?? base;
  if (!conn) throw new Error('Mongo not connected — call connectMongo() first');
  return conn.useDb(config.mongo.crmDb, { useCache: true });
}

export function appDb(): Connection {
  if (!base) throw new Error('Mongo not connected — call connectMongo() first');
  return base.useDb(config.mongo.appDb, { useCache: true });
}

export async function disconnectMongo(): Promise<void> {
  if (crmWrite) {
    await crmWrite.close();
    crmWrite = null;
  }
  if (base) {
    await mongoose.disconnect();
    base = null;
  }
}
