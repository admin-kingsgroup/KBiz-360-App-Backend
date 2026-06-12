import { fcm } from '../../push/fcm';
import { fcmDeviceRepo } from '../../push/fcm.devices';
import type { CallMediaType } from './call.models';

// Native incoming-call signalling via FCM data messages (firebase-admin). The client's background
// handler turns these into a full-screen notifee call UI (ring + Answer/Decline) even when killed.
// All-strings payload (FCM data requirement). No-op unless Firebase Admin is configured.
export const callFcm = {
  configured: (): boolean => fcm.isConfigured(),

  async sendIncomingCall(receiverId: string, callerName: string, call: { callId: string; type: CallMediaType; callerId: string }): Promise<number> {
    const tokens = await fcmDeviceRepo.tokensForUser(receiverId);
    if (!tokens.length) return 0;
    const data = { type: 'call', callId: call.callId, callType: call.type, callerName, callerId: call.callerId };
    let sent = 0;
    for (const t of tokens) if (await fcm.sendData(t, data)) sent++;
    // eslint-disable-next-line no-console
    console.log(`[call-fcm] incoming-call data → ${sent}/${tokens.length} device(s) for ${receiverId}`);
    return sent;
  },

  // Dismiss the ringing full-screen notification on the callee (rejected / missed / ended elsewhere).
  async sendCancel(receiverId: string, callId: string): Promise<void> {
    const tokens = await fcmDeviceRepo.tokensForUser(receiverId);
    for (const t of tokens) await fcm.sendData(t, { type: 'call_cancel', callId });
  },
};
