import mongoose, { type Connection } from 'mongoose';
import { config } from '../config';

// One Mongoose connection to the Atlas cluster, with two logical databases:
//   • crmDb()  → the CRM/ERP database (READ-ONLY by convention — we never define write models on it)
//   • appDb()  → the KBiz360 app's OWN database (all app writes go here, isolated from the CRM)
let base: Connection | null = null;

export async function connectMongo(): Promise<Connection> {
  if (base && base.readyState === 1) return base;
  if (!config.mongo.uri) throw new Error('MONGODB_URI not set');
  await mongoose.connect(config.mongo.uri, { serverSelectionTimeoutMS: 10000 });
  base = mongoose.connection;
  return base;
}

export function crmDb(): Connection {
  if (!base) throw new Error('Mongo not connected — call connectMongo() first');
  return base.useDb(config.mongo.crmDb, { useCache: true });
}

export function appDb(): Connection {
  if (!base) throw new Error('Mongo not connected — call connectMongo() first');
  return base.useDb(config.mongo.appDb, { useCache: true });
}

export async function disconnectMongo(): Promise<void> {
  if (base) {
    await mongoose.disconnect();
    base = null;
  }
}
