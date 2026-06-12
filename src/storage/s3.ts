import crypto from 'crypto';
import { type StorageAdapter, type StorageSaveInput, type StorageSaveResult, safeName } from './types';

// Puts the object in S3 and returns a public URL. The AWS SDK is imported lazily so it never loads
// for the local driver. Configure via S3_BUCKET / S3_REGION (+ standard AWS credential env vars).
export class S3StorageAdapter implements StorageAdapter {
  async save({ buffer, filename, mimeType }: StorageSaveInput): Promise<StorageSaveResult> {
    const bucket = process.env.S3_BUCKET;
    const region = process.env.S3_REGION ?? 'us-east-1';
    if (!bucket) throw new Error('S3_BUCKET not configured');

    const { S3Client, PutObjectCommand } = await import('@aws-sdk/client-s3');
    const client = new S3Client({ region });
    const key = `uploads/${crypto.randomUUID()}-${safeName(filename)}`;
    await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: buffer, ContentType: mimeType }));
    return { key, url: `https://${bucket}.s3.${region}.amazonaws.com/${key}` };
  }
}
