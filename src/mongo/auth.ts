import crypto from 'crypto';
import * as bcrypt from 'bcryptjs';
import { Unauthorized, Forbidden } from '../common/errors';
import { signAccess, signRefresh, verifyRefresh } from '../modules/auth/jwt';
import { appDb } from './connection';
import { crmRepo, type CrmUser } from './crm.repo';
import { accessService, type MongoAccess } from './access';
import { appAccess } from './appAccess';
import { userAvatars } from './userAvatars';
import { alertGrants } from './alerts/alertGrants';

const sha256 = (s: string): string => crypto.createHash('sha256').update(s).digest('hex');

// App-owned session store (in kb360_app — NEVER the CRM). Refresh tokens kept hashed.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sessions = () => appDb().collection('app_sessions') as any;

export interface PublicUser {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  name: string;
  phone: string | null;
  role: string;
  level: number;
  branchIds: string[];
  avatar: string | null;
}

function toPublic(user: CrmUser, access: MongoAccess, avatar: string | null): PublicUser {
  const firstName = user.first_name ?? '';
  const lastName = user.last_name ?? '';
  return {
    id: String(user._id),
    email: user.email,
    firstName,
    lastName,
    name: `${firstName} ${lastName}`.trim() || user.email,
    phone: user.phone ?? null,
    role: access.roleName,
    level: access.level,
    branchIds: (user.branch_ids ?? []).map(String),
    avatar,
  };
}

async function issueTokens(userId: string, roleName: string): Promise<{ accessToken: string; refreshToken: string }> {
  const accessToken = signAccess(userId, roleName);
  const jti = crypto.randomUUID();
  const refreshToken = signRefresh(userId, jti);
  const claims = verifyRefresh(refreshToken);
  await sessions().insertOne({
    userId,
    tokenHash: sha256(refreshToken),
    expiresAt: new Date((claims.exp ?? 0) * 1000),
    revokedAt: null,
    createdAt: new Date(),
  });
  return { accessToken, refreshToken };
}

export const mongoAuth = {
  // Verify credentials against the CRM users collection (READ-ONLY). We do NOT write last_login_at
  // to the CRM. Sessions are persisted in kb360_app only.
  async login(identifier: string, password: string) {
    const user = await crmRepo.findUserByEmail(identifier);
    if (!user || !user.password) throw Unauthorized('Invalid credentials');
    if (user.status && user.status !== 'active') throw Unauthorized('Account is not active');
    // Per-app login gate — DENY-by-default. Smart Connect is an explicit allow-list managed
    // in the ERP (Settings → Users & Roles → App Access); only access.app === true may sign in.
    if (user.access?.app !== true) {
      throw Forbidden("You don't have access to this app. Ask an administrator to enable it.");
    }
    const ok = await bcrypt.compare(password, user.password);
    if (!ok) throw Unauthorized('Invalid credentials');

    const access = await accessService.accessForUser(user);
    // App-access gate (super-admin controlled). Blocks sign-in for a disabled user.
    if (await appAccess.isDisabled(access.userId)) {
      throw Forbidden('Your access to the app has been disabled by an administrator.');
    }
    const tokens = await issueTokens(access.userId, access.roleName);
    access.alerts = await alertGrants.grantsFor(access.userId);
    return { ...tokens, user: toPublic(user, access, await userAvatars.urlFor(access.userId)), access };
  },

  async me(userId: string) {
    const user = await crmRepo.getUserById(userId);
    if (!user) throw Unauthorized('Session user not found');
    const access = await accessService.accessForUser(user);
    access.alerts = await alertGrants.grantsFor(access.userId);
    return { user: toPublic(user, access, await userAvatars.urlFor(access.userId)), access };
  },

  async refresh(refreshToken: string) {
    let claims;
    try {
      claims = verifyRefresh(refreshToken);
    } catch {
      throw Unauthorized('Invalid refresh token');
    }
    const stored = await sessions().findOne({ tokenHash: sha256(refreshToken) });
    if (!stored || stored.revokedAt || new Date(stored.expiresAt).getTime() < Date.now()) {
      throw Unauthorized('Refresh token expired or revoked');
    }
    const user = await crmRepo.getUserById(claims.sub);
    if (!user) throw Unauthorized('Session user not found');
    // App-access gate: a user without access cannot renew their session. Two independent
    // switches — the mobile super-admin's own toggle (kb360_app) and the ERP-managed
    // App Access allow-list (deny-by-default: access.app must be === true) — either blocks.
    if (await appAccess.isDisabled(String(claims.sub))) throw Unauthorized('Access disabled');
    if (user.access?.app !== true) throw Unauthorized('Access disabled');
    const access = await accessService.accessForUser(user);
    await sessions().updateOne({ _id: stored._id }, { $set: { revokedAt: new Date() } });
    return issueTokens(access.userId, access.roleName);
  },

  async logout(refreshToken: string) {
    await sessions().updateOne({ tokenHash: sha256(refreshToken), revokedAt: null }, { $set: { revokedAt: new Date() } });
  },

  // Revoke ALL of a user's refresh sessions (used when a super-admin disables their access).
  async revokeAllSessions(userId: string) {
    await sessions().updateMany({ userId, revokedAt: null }, { $set: { revokedAt: new Date() } });
  },
};
