import { config } from '../config';
import { Unauthorized, BadRequest } from '../common/errors';
import { emailAccountRepo } from './account.model';
import { encryptToken, decryptToken } from './crypto';

// Microsoft identity platform v2 — delegated, PKCE public client. The app sends us the auth code;
// we exchange it (and refresh later) server-side and keep the refresh token encrypted.
const SCOPE = 'openid profile email offline_access User.Read Mail.Read Mail.ReadWrite Mail.Send';
const tokenUrl = (): string => `https://login.microsoftonline.com/${config.msEmail.tenantId}/oauth2/v2.0/token`;

interface TokenResponse { access_token: string; refresh_token?: string; expires_in: number; scope?: string }

async function postToken(params: Record<string, string>): Promise<TokenResponse> {
  if (!config.msEmail.clientId) throw BadRequest('Microsoft email is not configured (MS_CLIENT_ID missing)');
  const resp = await fetch(tokenUrl(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: config.msEmail.clientId, scope: SCOPE, ...params }),
  });
  const json = (await resp.json()) as TokenResponse & { error?: string; error_description?: string };
  if (!resp.ok) throw BadRequest(`Microsoft token error: ${json.error_description ?? json.error ?? resp.status}`);
  return json;
}

export const msOAuth = {
  exchangeCode: (code: string, codeVerifier: string, redirectUri: string): Promise<TokenResponse> =>
    postToken({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: codeVerifier }),

  refresh: (refreshToken: string): Promise<TokenResponse> =>
    postToken({ grant_type: 'refresh_token', refresh_token: refreshToken }),

  // Persist a freshly-issued token set for a user (refresh token rotates → re-encrypt).
  async store(userId: string, email: string, msUserId: string | null, tokens: TokenResponse): Promise<void> {
    await emailAccountRepo.upsert(userId, {
      email,
      msUserId,
      ...(tokens.refresh_token ? { refreshTokenEnc: encryptToken(tokens.refresh_token) } : {}),
      accessToken: tokens.access_token,
      accessTokenExpiresAt: new Date(Date.now() + tokens.expires_in * 1000),
      scope: tokens.scope ?? SCOPE,
    });
  },

  // Return a valid access token for the user, refreshing if the cached one is near expiry.
  async getValidAccessToken(userId: string): Promise<string> {
    const acct = await emailAccountRepo.find(userId);
    if (!acct) throw Unauthorized('Email not connected');
    if (acct.accessToken && acct.accessTokenExpiresAt && acct.accessTokenExpiresAt.getTime() > Date.now() + 60_000) {
      return acct.accessToken;
    }
    const tokens = await msOAuth.refresh(decryptToken(acct.refreshTokenEnc));
    await emailAccountRepo.update(userId, {
      ...(tokens.refresh_token ? { refreshTokenEnc: encryptToken(tokens.refresh_token) } : {}),
      accessToken: tokens.access_token,
      accessTokenExpiresAt: new Date(Date.now() + tokens.expires_in * 1000),
    });
    return tokens.access_token;
  },
};
