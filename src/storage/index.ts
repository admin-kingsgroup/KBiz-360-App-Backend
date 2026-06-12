import { config } from '../config';
import { type StorageAdapter } from './types';
import { LocalStorageAdapter } from './local';
import { S3StorageAdapter } from './s3';

// Adapter factory — picks the driver from config (local | s3).
let adapter: StorageAdapter | null = null;
export function getStorage(): StorageAdapter {
  if (!adapter) adapter = config.storage.driver === 's3' ? new S3StorageAdapter() : new LocalStorageAdapter();
  return adapter;
}

export type { StorageAdapter } from './types';
