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
}
