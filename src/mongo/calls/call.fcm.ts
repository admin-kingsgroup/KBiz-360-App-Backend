import { fcm } from '../../push/fcm';
import { fcmDeviceRepo } from '../../push/fcm.devices';
import type { CallMediaType } from './call.models';

// Native incoming-call signalling via FCM data messages (firebase-admin). The client's background
// handler turns these into a full-screen notifee call UI (ring + Answer/Decline) even when killed.
// All-strings payload (FCM data requirement). No-op unless Firebase Admin is configured.
export const callFcm = {
  configured: (): boolean => fcm.isConfigured(),

  // skipIos: when iOS calls are handled by native VoIP/CallKit (callVoip configured), don't ALSO send
  // the iOS an FCM alert — that would double-notify. Android always uses the data payload (notifee).
  async sendIncomingCall(
    receiverId: string,
    callerName: string,
    call: { callId: string; type: CallMediaType; callerId: string },
    opts: { skipIos?: boolean } = {},
  ): Promise<number> {
    const devices = await fcmDeviceRepo.devicesForUser(receiverId);
    const targets = opts.skipIos ? devices.filter((d) => d.platform !== 'ios') : devices;
    if (!targets.length) return 0;
    const data = { type: 'call', callId: call.callId, callType: call.type, callerName, callerId: call.callerId };
    // iOS shows this as a notification (data-only is silent on iOS); Android uses the data payload
    // for the full-screen notifee UI.
    const apnsAlert = { title: 'Incoming call', body: `${callerName} is calling…`, category: 'incoming_call' };
    let sent = 0;
    for (const d of targets) if (await fcm.sendData(d.fcmToken, data, apnsAlert)) sent++;
    // eslint-disable-next-line no-console
    console.log(`[call-fcm] incoming-call data → ${sent}/${targets.length} device(s) for ${receiverId}${opts.skipIos ? ' (iOS via VoIP)' : ''}`);
    return sent;
  },

  // Dismiss the ringing full-screen notification on the callee (rejected / missed / ended elsewhere).
  async sendCancel(receiverId: string, callId: string): Promise<void> {
    const tokens = await fcmDeviceRepo.tokensForUser(receiverId);
    for (const t of tokens) await fcm.sendData(t, { type: 'call_cancel', callId });
  },
};
