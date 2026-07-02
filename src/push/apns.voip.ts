import http2 from 'http2';
import { readFileSync } from 'fs';
import crypto from 'crypto';
import { config } from '../config';
import { voipDeviceRepo } from './voip.devices';

// Apple VoIP/PushKit sender over APNs HTTP/2 with token-based (.p8) auth. Sends a VoIP push that the
// iOS app turns into a native CallKit incoming-call screen (via react-native-callkeep). Entirely
// optional: isConfigured() is false unless APNS_KEY_PATH/APNS_KEY_ID/APNS_TEAM_ID are all set, in
// which case callers fall back to the FCM alert notification.
//
// One APNs auth key (.p8) signs a short-lived ES256 JWT reused across requests (Apple recommends
// regenerating no more than once every ~20 min and no less than once an hour). The VoIP topic is
// `<bundleId>.voip`. The device token's environment (sandbox vs production) must match the host, so
// we try the configured host first and fall back to the other on a BadDeviceToken.

const HOST_PROD = 'api.push.apple.com';
const HOST_SANDBOX = 'api.sandbox.push.apple.com';

let privateKey: crypto.KeyObject | null = null;
let keyTried = false;

function getKey(): crypto.KeyObject | null {
  if (privateKey || keyTried) return privateKey;
  keyTried = true;
  const p = config.apnsVoip.keyPath;
  if (!p || !config.apnsVoip.keyId || !config.apnsVoip.teamId) return null;
  try {
    privateKey = crypto.createPrivateKey(readFileSync(p, 'utf8'));
    // eslint-disable-next-line no-console
    console.log('[apns-voip] auth key loaded');
    return privateKey;
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[apns-voip] key load failed (falling back to FCM alert):', (e as Error).message);
    return null;
  }
}

const b64url = (b: Buffer | string): string =>
  Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// Cache the signed JWT and regenerate every ~40 minutes.
let cachedJwt: { token: string; at: number } | null = null;
function authToken(): string | null {
  const key = getKey();
  if (!key) return null;
  const now = Math.floor(Date.now() / 1000);
  if (cachedJwt && now - cachedJwt.at < 40 * 60) return cachedJwt.token;
  const header = b64url(JSON.stringify({ alg: 'ES256', kid: config.apnsVoip.keyId }));
  const claims = b64url(JSON.stringify({ iss: config.apnsVoip.teamId, iat: now }));
  const signingInput = `${header}.${claims}`;
  // ieee-p1363 → raw r||s signature (JOSE format) required by JWT/APNs (not DER).
  const sig = crypto.sign('sha256', Buffer.from(signingInput), { key, dsaEncoding: 'ieee-p1363' });
  const token = `${signingInput}.${b64url(sig)}`;
  cachedJwt = { token, at: now };
  return token;
}

// Reused HTTP/2 sessions keyed by host.
const sessions = new Map<string, http2.ClientHttp2Session>();
function sessionFor(host: string): http2.ClientHttp2Session {
  const existing = sessions.get(host);
  if (existing && !existing.closed && !existing.destroyed) return existing;
  const s = http2.connect(`https://${host}`);
  s.on('error', () => sessions.delete(host));
  s.on('close', () => sessions.delete(host));
  sessions.set(host, s);
  return s;
}

interface ApnsResult { status: number; reason?: string }

function post(host: string, token: string, jwt: string, body: string): Promise<ApnsResult> {
  return new Promise((resolve) => {
    let session: http2.ClientHttp2Session;
    try {
      session = sessionFor(host);
    } catch {
      resolve({ status: 0, reason: 'connect-failed' });
      return;
    }
    const req = session.request({
      ':method': 'POST',
      ':path': `/3/device/${token}`,
      authorization: `bearer ${jwt}`,
      'apns-topic': `${config.apnsVoip.bundleId}.voip`,
      'apns-push-type': 'voip',
      'apns-priority': '10',
      'apns-expiration': String(Math.floor(Date.now() / 1000) + 30),
      'content-type': 'application/json',
    });
    let status = 0;
    let data = '';
    req.on('response', (headers) => { status = Number(headers[':status']) || 0; });
    req.setEncoding('utf8');
    req.on('data', (c) => { data += c; });
    req.on('end', () => {
      let reason: string | undefined;
      if (data) { try { reason = (JSON.parse(data) as { reason?: string }).reason; } catch { /* ignore */ } }
      resolve({ status, reason });
    });
    req.on('error', (e) => resolve({ status: 0, reason: e.message }));
    req.setTimeout(8000, () => { req.close(); resolve({ status: 0, reason: 'timeout' }); });
    req.write(body);
    req.end();
  });
}

export const apnsVoip = {
  isConfigured(): boolean {
    return getKey() !== null;
  },

  // Send a VoIP push to one device token. `production` selects the primary APNs host; on a
  // BadDeviceToken we retry the other host (covers dev/store token-environment mismatches).
  async send(token: string, payload: Record<string, unknown>, production: boolean): Promise<boolean> {
    const jwt = authToken();
    if (!jwt) return false;
    const body = JSON.stringify(payload);
    const primary = production ? HOST_PROD : HOST_SANDBOX;
    const secondary = production ? HOST_SANDBOX : HOST_PROD;
    let res = await post(primary, token, jwt, body);
    if (res.status === 400 && res.reason === 'BadDeviceToken') res = await post(secondary, token, jwt, body);
    if (res.status === 200) return true;
    // Prune unregistered tokens (410 Unregistered, or BadDeviceToken from both environments).
    if (res.status === 410 || (res.status === 400 && res.reason === 'BadDeviceToken')) {
      void voipDeviceRepo.remove(token);
    }
    // eslint-disable-next-line no-console
    console.warn(`[apns-voip] send failed status=${res.status} reason=${res.reason ?? 'n/a'}`);
    return false;
  },
};
