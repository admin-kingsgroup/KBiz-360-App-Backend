// Storage adapter contract. Implementations: LocalStorageAdapter, S3StorageAdapter.
export interface StorageSaveInput {
  buffer: Buffer;
  filename: string;
  mimeType?: string;
}

export interface StorageSaveResult {
  key: string;
  url: string;
}

export interface StorageAdapter {
  save(input: StorageSaveInput): Promise<StorageSaveResult>;
}

export function safeName(filename: string): string {
  return filename.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120) || 'file';
}
