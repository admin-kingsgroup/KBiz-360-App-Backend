import { config } from '../../config';
import { callDeviceRepo } from './call.repository';
import type { CallMediaType } from './call.models';

// Mongo-only push for incoming calls. Tokens live in push_devices (kb360_app); delivery is a plain
// POST to the Expo Push API (no SDK, no Prisma, no BullMQ) so the calling feature is self-contained.
const isExpoPushToken = (t: string): boolean => /^Expo(nent)?PushToken\[[^\]]+\]$/.test(t);
const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

interface ExpoMessage {
  to: string;
  title: string;
  body: string;
  data: Record<string, unknown>;
  sound: 'default';
  priority: 'high';
  channelId: 'calls';
  categoryId: 'incoming_call'; // attaches the Accept/Decline action buttons (registered on the client)
}

async function postToExpo(messages: ExpoMessage[]): Promise<void> {
  for (let i = 0; i < messages.length; i += 100) {
    const chunk = messages.slice(i, i + 100);
    try {
      await fetch(EXPO_PUSH_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          ...(config.push.expoAccessToken ? { Authorization: `Bearer ${config.push.expoAccessToken}` } : {}),
        },
        body: JSON.stringify(chunk),
      });
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[call-push] send error:', (e as Error).message);
    }
  }
}

export const callPush = {
  registerDevice(userId: string, expoPushToken: string, platform?: string): Promise<unknown> {
    return callDeviceRepo.upsert(userId, expoPushToken, platform ?? null);
  },

  // Ring an offline/backgrounded callee. Returns the number of devices targeted.
  async sendIncomingCall(receiverId: string, callerName: string, call: { callId: string; type: CallMediaType }): Promise<number> {
    const tokens = (await callDeviceRepo.tokensForUser(receiverId)).filter(isExpoPushToken);
    if (!tokens.length) return 0;

    const messages: ExpoMessage[] = tokens.map((to) => ({
      to,
      title: 'Incoming call',
      body: `${callerName} is calling…`,
      data: { type: 'call', id: call.callId, callId: call.callId, callType: call.type, from: callerName },
      sound: 'default',
      priority: 'high',
      channelId: 'calls',
      categoryId: 'incoming_call',
    }));

    if (!config.push.enabled) {
      // eslint-disable-next-line no-console
      console.log(`[call-push] dry-run incoming-call push to ${tokens.length} device(s) for ${receiverId}`);
      return tokens.length;
    }
    await postToExpo(messages);
    return tokens.length;
  },
};
