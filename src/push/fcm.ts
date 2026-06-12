import { readFileSync } from 'fs';
import admin from 'firebase-admin';
import { config } from '../config';

// Firebase Admin wrapper for DATA-only FCM messages (high priority) — used to wake a killed/
// backgrounded Android app so it can draw the native full-screen incoming-call UI (notifee).
// Entirely optional: if FIREBASE_SERVICE_ACCOUNT is not configured, isConfigured() is false and
// callers fall back to Expo push. Lazy-initialised so the app boots without Firebase.
let app: admin.app.App | null = null;
let tried = false;

function getApp(): admin.app.App | null {
  if (app || tried) return app;
  tried = true;
  const path = config.firebase.serviceAccountPath;
  if (!path) return null;
  try {
    const json = JSON.parse(readFileSync(path, 'utf8')) as admin.ServiceAccount;
    app = admin.initializeApp({ credential: admin.credential.cert(json) }, 'kb360-fcm');
    // eslint-disable-next-line no-console
    console.log('[fcm] firebase-admin initialised');
    return app;
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[fcm] init failed (falling back to Expo push):', (e as Error).message);
    return null;
  }
}

export const fcm = {
  isConfigured(): boolean {
    return getApp() !== null;
  },

  // Send a high-priority DATA message to one device's raw FCM token. Returns true if delivered to
  // FCM (not a guarantee of device delivery). Data values must be strings (FCM requirement).
  async sendData(token: string, data: Record<string, string>): Promise<boolean> {
    const a = getApp();
    if (!a) return false;
    try {
      await a.messaging().send({
        token,
        data,
        android: { priority: 'high' }, // wakes the app from Doze for the background handler
        apns: { headers: { 'apns-priority': '10', 'apns-push-type': 'background' }, payload: { aps: { contentAvailable: true } } },
      });
      return true;
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[fcm] sendData error:', (e as Error).message);
      return false;
    }
  },
};
