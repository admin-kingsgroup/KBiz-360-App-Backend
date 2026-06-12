import crypto from 'crypto';
import * as bcrypt from 'bcryptjs';
import type { User as PrismaUser } from '@prisma/client';
import { prisma } from '../../db/prisma';
import { Unauthorized } from '../../common/errors';
import { writeAudit } from '../../common/audit';
import { signAccess, signRefresh, verifyRefresh } from './jwt';
import { accessService, toDomainUser } from '../access/access.service';
import type { AccessControl, User as DomainUser } from '../../domain/types';

const sha256 = (s: string): string => crypto.createHash('sha256').update(s).digest('hex');

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

export interface SessionPayload extends AuthTokens {
  user: DomainUser;
  access: AccessControl;
}

// Issue an access + refresh pair and persist the (hashed) refresh token for rotation/revocation.
async function issueTokens(user: PrismaUser): Promise<AuthTokens> {
  const accessToken = signAccess(user.id, user.role);
  const jti = crypto.randomUUID();
  const refreshToken = signRefresh(user.id, jti);
  const claims = verifyRefresh(refreshToken); // read exp
  await prisma.refreshToken.create({
    data: {
      userId: user.id,
      tokenHash: sha256(refreshToken),
      expiresAt: new Date((claims.exp ?? 0) * 1000),
    },
  });
  return { accessToken, refreshToken };
}

export const authService = {
  // POST /auth/login — verify credentials, issue tokens, return user + derived access.
  // `identifier` matches email OR legacyAdminId OR id (the frontend login uses a free "User ID").
  async login(identifier: string, password: string): Promise<SessionPayload> {
    const user = await prisma.user.findFirst({
      where: { OR: [{ email: identifier }, { legacyAdminId: identifier }, { id: identifier }] },
    });
    if (!user || !user.passwordHash) throw Unauthorized('Invalid credentials');
    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) throw Unauthorized('Invalid credentials');

    const tokens = await issueTokens(user);
    await writeAudit({ actorId: user.id, action: 'LOGIN', entity: 'Auth', entityId: user.id });
    return { ...tokens, user: toDomainUser(user), access: accessService.accessForUser(user) };
  },

  // GET /auth/me — resolve the access-token subject to user + access.
  async me(userId: string): Promise<{ user: DomainUser; access: AccessControl }> {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw Unauthorized('Session user not found');
    return { user: toDomainUser(user), access: accessService.accessForUser(user) };
  },

  // POST /auth/refresh — verify + rotate. Old token is revoked; a new pair is issued.
  async refresh(refreshToken: string): Promise<AuthTokens> {
    let claims;
    try {
      claims = verifyRefresh(refreshToken);
    } catch {
      throw Unauthorized('Invalid refresh token');
    }
    const hash = sha256(refreshToken);
    const stored = await prisma.refreshToken.findUnique({ where: { tokenHash: hash } });
    if (!stored || stored.revokedAt || stored.expiresAt.getTime() < Date.now()) {
      throw Unauthorized('Refresh token expired or revoked');
    }
    const user = await prisma.user.findUnique({ where: { id: claims.sub } });
    if (!user) throw Unauthorized('Session user not found');

    await prisma.refreshToken.update({ where: { id: stored.id }, data: { revokedAt: new Date() } });
    const tokens = await issueTokens(user);
    await writeAudit({ actorId: user.id, action: 'REFRESH', entity: 'Auth', entityId: user.id });
    return tokens;
  },

  // POST /auth/logout — revoke the presented refresh token (idempotent).
  async logout(refreshToken: string): Promise<void> {
    const hash = sha256(refreshToken);
    const stored = await prisma.refreshToken.findUnique({ where: { tokenHash: hash } });
    if (stored && !stored.revokedAt) {
      await prisma.refreshToken.update({ where: { id: stored.id }, data: { revokedAt: new Date() } });
      await writeAudit({ actorId: stored.userId, action: 'LOGOUT', entity: 'Auth', entityId: stored.userId });
    }
  },
};
