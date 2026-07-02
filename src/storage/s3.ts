import crypto from 'crypto';
import { type StorageAdapter, type StorageSaveInput, type StorageSaveResult, safeName } from './types';

// Stores objects in S3 and returns a public URL. The AWS SDK is imported lazily so it never loads for
// the local driver. Configure via:
//   STORAGE_DRIVER=s3
//   S3_BUCKET=<bucket>           (required)
//   S3_REGION=<region>           (default us-east-1)
//   S3_PUBLIC_BASE_URL=<url>     (optional — a CloudFront/custom domain; else the S3 virtual-hosted URL)
// Credentials come from the standard AWS chain (an EC2 IAM role is best; or AWS_ACCESS_KEY_ID/SECRET).
// The bucket (or the uploads/* prefix) must allow public GET for the returned URLs to load in the app.
export class S3StorageAdapter implements StorageAdapter {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private client: any = null;

  async save({ buffer, filename, mimeType }: StorageSaveInput): Promise<StorageSaveResult> {
    const bucket = process.env.S3_BUCKET;
    if (!bucket) throw new Error('S3_BUCKET not configured');
    const region = process.env.S3_REGION ?? 'us-east-1';

    const { S3Client, PutObjectCommand } = await import('@aws-sdk/client-s3');
    if (!this.client) {
      // Honour explicit S3_* keys (as documented in .env), else fall back to the default AWS chain
      // (AWS_* env vars or an EC2 IAM role).
      const accessKeyId = process.env.S3_ACCESS_KEY_ID;
      const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY;
      this.client = new S3Client({
        region,
        ...(accessKeyId && secretAccessKey ? { credentials: { accessKeyId, secretAccessKey } } : {}),
      });
    }
    const key = `uploads/${crypto.randomUUID()}-${safeName(filename)}`;
    await this.client.send(new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: buffer,
      ContentType: mimeType,
      CacheControl: 'public, max-age=31536000, immutable', // content-addressed media → cache hard
    }));
    const base = (process.env.S3_PUBLIC_BASE_URL ?? `https://${bucket}.s3.${region}.amazonaws.com`).replace(/\/+$/, '');
    return { key, url: `${base}/${key}` };
  }
}
