import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { config } from '../config';
import { type StorageAdapter, type StorageSaveInput, type StorageSaveResult, safeName } from './types';

// Writes to a local directory and returns a URL served by express.static('/uploads').
export class LocalStorageAdapter implements StorageAdapter {
  constructor(
    private readonly dir: string = config.storage.localDir,
    private readonly publicBase: string = '/uploads',
  ) {}

  async save({ buffer, filename }: StorageSaveInput): Promise<StorageSaveResult> {
    await fs.promises.mkdir(this.dir, { recursive: true });
    const key = `${crypto.randomUUID()}-${safeName(filename)}`;
    await fs.promises.writeFile(path.join(this.dir, key), buffer);
    return { key, url: `${this.publicBase}/${key}` };
  }

  async delete(key: string): Promise<void> {
    // Keys are single path segments (uuid-name); refuse anything that could escape the dir.
    if (!key || key.includes('/') || key.includes('..')) return;
    await fs.promises.unlink(path.join(this.dir, key)).catch(() => undefined);
  }

  async signedUrl(key: string): Promise<string> {
    // Local files are served by the public /uploads static mount — nothing to sign in dev.
    return `${this.publicBase}/${key}`;
  }
}
