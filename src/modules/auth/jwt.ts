import jwt, { type SignOptions } from 'jsonwebtoken';
import { config } from '../../config';

export interface AccessClaims {
  sub: string;
  role: string;
  type: 'access';
  iat?: number;
  exp?: number;
}

export interface RefreshClaims {
  sub: string;
  jti: string;
  type: 'refresh';
  iat?: number;
  exp?: number;
}

export function signAccess(userId: string, role: string): string {
  return jwt.sign({ sub: userId, role, type: 'access' }, config.jwt.accessSecret, {
    expiresIn: config.jwt.accessTtl,
  } as SignOptions);
}

export function signRefresh(userId: string, jti: string): string {
  return jwt.sign({ sub: userId, jti, type: 'refresh' }, config.jwt.refreshSecret, {
    expiresIn: config.jwt.refreshTtl,
  } as SignOptions);
}

export function verifyAccess(token: string): AccessClaims {
  return jwt.verify(token, config.jwt.accessSecret) as AccessClaims;
}

export function verifyRefresh(token: string): RefreshClaims {
  return jwt.verify(token, config.jwt.refreshSecret) as RefreshClaims;
}
