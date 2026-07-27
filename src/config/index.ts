import 'dotenv/config';

// Typed application configuration, loaded once from the environment.
export interface AppConfig {
  env: string;
  port: number;
  database: { url: string };
  jwt: {
    accessSecret: string;
    refreshSecret: string;
    accessTtl: string;
    refreshTtl: string;
  };
  redis: { host: string; port: number };
  storage: { driver: 'local' | 's3'; localDir: string };
  push: { enabled: boolean; expoAccessToken?: string };
  firebase: { serviceAccountPath?: string };
  // Apple VoIP push (PushKit) → native CallKit incoming-call screen on iOS. Token-based auth (.p8).
  apnsVoip: { keyPath?: string; keyId?: string; teamId?: string; bundleId: string; production: boolean };
  msEmail: { clientId: string; tenantId: string; tokenKey: string };
  // Shared secret the ERP/CRM backends present to POST /api/alerts/ingest. Unset = ingest disabled.
  alerts: { ingestToken?: string };
  mongo: { uri: string; crmDb: string; appDb: string };
  // Audio-calling: WebRTC ICE servers (STUN always, TURN optional) + ring timeout. Creds from env only.
  calls: {
    stunUrl: string;
    turnUrls: string[]; // one or more TURN URLs (comma-separated in env), e.g. turn:host:3478?transport=udp
    turnSecret?: string; // coturn `static-auth-secret` → time-limited (HMAC) credentials, the secure standard
    turnTtlSec: number; // lifetime of an issued TURN credential
    turnUsername?: string; // legacy static creds (used only if turnSecret is unset)
    turnPassword?: string;
    ringTimeoutSec: number;
  };
}

export const config: AppConfig = {
  env: process.env.NODE_ENV ?? 'development',
  port: parseInt(process.env.PORT ?? '4000', 10),
  database: { url: process.env.DATABASE_URL ?? '' },
  jwt: {
    // No fallback secret by design — an unset/weak value is rejected at startup by validateAuthConfig
    // (src/config/validateEnv.ts). The '' placeholder only satisfies the type; the server exits
    // before any signing happens if the real secret is missing.
    accessSecret: process.env.JWT_ACCESS_SECRET ?? '',
    refreshSecret: process.env.JWT_REFRESH_SECRET ?? '',
    accessTtl: process.env.JWT_ACCESS_TTL ?? '900s',
    // Sliding session: every app use rotates the pair with a fresh TTL, so this is INACTIVITY
    // time before a forced re-login — not an absolute session cap. A year ≈ "until manual logout".
    refreshTtl: process.env.JWT_REFRESH_TTL ?? '365d',
  },
  redis: {
    host: process.env.REDIS_HOST ?? 'localhost',
    port: parseInt(process.env.REDIS_PORT ?? '6379', 10),
  },
  storage: {
    driver: (process.env.STORAGE_DRIVER as 'local' | 's3') ?? 'local',
    localDir: process.env.STORAGE_LOCAL_DIR ?? './uploads',
  },
  push: {
    enabled: process.env.EXPO_PUSH_ENABLED === 'true', // off by default (dev/test = dry-run)
    expoAccessToken: process.env.EXPO_ACCESS_TOKEN,
  },
  // Firebase Admin (data FCM messages → native full-screen incoming-call UI). Optional: when
  // FIREBASE_SERVICE_ACCOUNT (path to the service-account JSON) is unset, calls fall back to Expo push.
  firebase: {
    serviceAccountPath: process.env.FIREBASE_SERVICE_ACCOUNT || undefined,
  },
  // Apple VoIP/PushKit → CallKit. Uses an APNs auth key (.p8) — the SAME key works for VoIP and
  // alert pushes (token-based). topic for VoIP is `<bundleId>.voip`. Optional: when unset, iOS calls
  // fall back to the FCM alert notification (no native CallKit screen).
  apnsVoip: {
    keyPath: process.env.APNS_KEY_PATH || undefined, // path to the AuthKey_XXXX.p8 file
    keyId: process.env.APNS_KEY_ID || undefined, // 10-char Key ID from Apple Developer → Keys
    teamId: process.env.APNS_TEAM_ID || undefined, // 10-char Apple Developer Team ID
    bundleId: process.env.APNS_BUNDLE_ID || 'com.kingsgroup.kbiz360',
    production: process.env.APNS_PRODUCTION === 'true', // false → sandbox (dev builds); auto-fallback either way
  },
  // Microsoft 365 email (Graph) — per-user delegated OAuth (PKCE public client). clientId/tenantId
  // come from the Azure app registration; tokenKey encrypts stored refresh tokens at rest. When
  // EMAIL_TOKEN_KEY is unset it reuses JWT_ACCESS_SECRET (validated strong at startup) — no weak
  // fallback; validateAuthConfig rejects a weak EMAIL_TOKEN_KEY if one is explicitly provided.
  msEmail: {
    clientId: process.env.MS_CLIENT_ID || '',
    tenantId: process.env.MS_TENANT_ID || 'common',
    tokenKey: process.env.EMAIL_TOKEN_KEY || process.env.JWT_ACCESS_SECRET || '',
  },
  alerts: {
    // Trimmed to mirror the ERP/CRM emitters (which trim theirs) — a padded paste in .env must
    // not cause unmatchable 401s; whitespace-only collapses to undefined (= ingest disabled).
    ingestToken: (process.env.ALERTS_INGEST_TOKEN || '').trim() || undefined,
  },
  mongo: {
    uri: process.env.MONGODB_URI ?? '',
    crmDb: process.env.CRM_DB ?? 'test', // READ-ONLY source (CRM/ERP)
    appDb: process.env.APP_DB ?? 'kb360_app', // app's own writes (isolated)
  },
  calls: {
    stunUrl: process.env.STUN_URL ?? 'stun:stun.l.google.com:19302',
    // TURN_URLS: comma-separated list (udp+tcp+tls variants of the same coturn server).
    turnUrls: (process.env.TURN_URLS || process.env.TURN_URL || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    turnSecret: process.env.TURN_STATIC_AUTH_SECRET || undefined,
    turnTtlSec: parseInt(process.env.TURN_TTL_SEC ?? '86400', 10),
    turnUsername: process.env.TURN_USERNAME || undefined,
    turnPassword: process.env.TURN_PASSWORD || undefined,
    ringTimeoutSec: parseInt(process.env.CALL_RING_TIMEOUT_SEC ?? '45', 10),
  },
};
