import { apnsVoip } from '../../push/apns.voip';
import { voipDeviceRepo } from '../../push/voip.devices';
import type { CallMediaType } from './call.models';

// iOS native CallKit signalling via Apple VoIP/PushKit. The client's PushKit handler reports a
// CallKit incoming call (ring + Accept/Reject, full-screen over the lock screen) even when killed.
// No-op unless the APNs VoIP key is configured (then callers fall back to the FCM alert).
export const callVoip = {
  configured: (): boolean => apnsVoip.isConfigured(),

  // How many VoIP/CallKit-capable devices the user has registered (i.e. is on a build with CallKit).
  async deviceCount(userId: string): Promise<number> {
    return (await voipDeviceRepo.devicesForUser(userId)).length;
  },

  async sendIncomingCall(receiverId: string, callerName: string, call: { callId: string; type: CallMediaType; callerId: string }): Promise<number> {
    const devices = await voipDeviceRepo.devicesForUser(receiverId);
    if (!devices.length) return 0;
    const payload = { type: 'call', event: 'incoming', callId: call.callId, callType: call.type, callerName, callerId: call.callerId };
    let sent = 0;
    for (const d of devices) if (await apnsVoip.send(d.voipToken, payload, d.production)) sent++;
    // eslint-disable-next-line no-console
    console.log(`[call-voip] incoming-call VoIP → ${sent}/${devices.length} iOS device(s) for ${receiverId}`);
    return sent;
  },

  // Tell the callee's CallKit to end the call (rejected elsewhere / missed / cancelled by caller).
  async sendCancel(receiverId: string, callId: string): Promise<void> {
    const devices = await voipDeviceRepo.devicesForUser(receiverId);
    const payload = { type: 'call', event: 'cancel', callId };
    for (const d of devices) await apnsVoip.send(d.voipToken, payload, d.production);
  },
};
