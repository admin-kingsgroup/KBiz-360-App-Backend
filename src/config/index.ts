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
  msEmail: { clientId: string; tenantId: string; tokenKey: string };
  mongo: { uri: string; crmDb: string; appDb: string };
  // Audio-calling: WebRTC ICE servers (STUN always, TURN optional) + ring timeout. Creds from env only.
  calls: {
    stunUrl: string;
    turnUrl?: string;
    turnUsername?: string;
    turnPassword?: string;
    ringTimeoutSec: number;
  };
}

export const config: AppConfig = {
  env: process.env.NODE_ENV ?? 'development',
  port: parseInt(process.env.PORT ?? '4000', 10),
  database: { url: process.env.DATABASE_URL ?? '' },
  jwt: {
    accessSecret: process.env.JWT_ACCESS_SECRET ?? 'change-me-access',
    refreshSecret: process.env.JWT_REFRESH_SECRET ?? 'change-me-refresh',
    accessTtl: process.env.JWT_ACCESS_TTL ?? '900s',
    refreshTtl: process.env.JWT_REFRESH_TTL ?? '30d',
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
  // Microsoft 365 email (Graph) — per-user delegated OAuth (PKCE public client). clientId/tenantId
  // come from the Azure app registration; tokenKey encrypts stored refresh tokens at rest.
  msEmail: {
    clientId: process.env.MS_CLIENT_ID || '',
    tenantId: process.env.MS_TENANT_ID || 'common',
    tokenKey: process.env.EMAIL_TOKEN_KEY || process.env.JWT_ACCESS_SECRET || 'dev-email-token-key',
  },
  mongo: {
    uri: process.env.MONGODB_URI ?? '',
    crmDb: process.env.CRM_DB ?? 'test', // READ-ONLY source (CRM/ERP)
    appDb: process.env.APP_DB ?? 'kb360_app', // app's own writes (isolated)
  },
  calls: {
    stunUrl: process.env.STUN_URL ?? 'stun:stun.l.google.com:19302',
    turnUrl: process.env.TURN_URL || undefined,
    turnUsername: process.env.TURN_USERNAME || undefined,
    turnPassword: process.env.TURN_PASSWORD || undefined,
    ringTimeoutSec: parseInt(process.env.CALL_RING_TIMEOUT_SEC ?? '45', 10),
  },
};
