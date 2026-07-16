// Storage adapter contract. Implementations: LocalStorageAdapter, S3StorageAdapter.
export interface StorageSaveInput {
  buffer: Buffer;
  filename: string;
  mimeType?: string;
  // S3 key prefix (default 'uploads'). A distinct prefix (e.g. 'alert-attachments') lets a
  // bucket policy treat those objects differently from public chat media. Local driver ignores it.
  prefix?: string;
}

export interface StorageSaveResult {
  key: string;
  url: string;
}

export interface StorageAdapter {
  save(input: StorageSaveInput): Promise<StorageSaveResult>;
  // Best-effort removal by the key save() returned. Missing objects are not an error.
  delete(key: string): Promise<void>;
  // Short-lived access URL for the key (S3: presigned GET; local: the public /uploads URL).
  signedUrl(key: string, ttlSec?: number): Promise<string>;
}

export function safeName(filename: string): string {
  return filename.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120) || 'file';
}
