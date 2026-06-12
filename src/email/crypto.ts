import crypto from 'crypto';
import { config } from '../config';

// AES-256-GCM encryption for Microsoft refresh tokens at rest. Key derived from EMAIL_TOKEN_KEY
// (or JWT secret in dev) via scrypt. Format: ivB64:tagB64:cipherB64.
const key = crypto.scryptSync(config.msEmail.tokenKey, 'kb360-email-v1', 32);

export function encryptToken(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return [iv.toString('base64'), cipher.getAuthTag().toString('base64'), enc.toString('base64')].join(':');
}

export function decryptToken(payload: string): string {
  const [ivB, tagB, dataB] = payload.split(':');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(dataB, 'base64')), decipher.final()]).toString('utf8');
}
