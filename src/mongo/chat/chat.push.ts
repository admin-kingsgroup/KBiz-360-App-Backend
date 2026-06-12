import { config } from '../../config';
import { callDeviceRepo } from '../calls/call.repository';

// Offline chat push. REUSES the shared Expo token registry (push_devices via callDeviceRepo) — no
// duplicate device collection/registration. Delivery is a plain POST to the Expo Push API
// (dry-run unless EXPO_PUSH_ENABLED=true). Payload data {type:'chat', id} → routes.ts deep-links
// the tap to /chat/[id].
const isExpoPushToken = (t: string): boolean => /^Expo(nent)?PushToken\[[^\]]+\]$/.test(t);
const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

interface ExpoMessage {
  to: string;
  title: string;
  body: string;
  data: Record<string, unknown>;
  sound: 'default';
  priority: 'high';
  channelId: 'default';
}

async function postToExpo(messages: ExpoMessage[]): Promise<void> {
  for (let i = 0; i < messages.length; i += 100) {
    const chunk = messages.slice(i, i + 100);
    try {
      const resp = await fetch(EXPO_PUSH_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          ...(config.push.expoAccessToken ? { Authorization: `Bearer ${config.push.expoAccessToken}` } : {}),
        },
        body: JSON.stringify(chunk),
      });
      // Log Expo's per-message tickets so delivery errors (DeviceNotRegistered, MessageTooBig, …) are visible.
      const json = (await resp.json().catch(() => null)) as { data?: { status: string; message?: string }[] } | null;
      // eslint-disable-next-line no-console
      console.log('[chat-push] expo response:', JSON.stringify(json?.data ?? json));
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[chat-push] send error:', (e as Error).message);
    }
  }
}

export const chatPush = {
  // Notify one offline recipient of a new message. Returns the number of devices targeted.
  async notifyNewMessage(receiverId: string, opts: { title: string; body: string; conversationId: string }): Promise<number> {
    const tokens = (await callDeviceRepo.tokensForUser(receiverId)).filter(isExpoPushToken);
    if (!tokens.length) return 0;
    const messages: ExpoMessage[] = tokens.map((to) => ({
      to,
      title: opts.title,
      body: opts.body,
      data: { type: 'chat', id: opts.conversationId, conversationId: opts.conversationId },
      sound: 'default',
      priority: 'high',
      channelId: 'default',
    }));
    if (!config.push.enabled) {
      // eslint-disable-next-line no-console
      console.log(`[chat-push] dry-run message push to ${tokens.length} device(s) for ${receiverId}`);
      return tokens.length;
    }
    await postToExpo(messages);
    return tokens.length;
  },
};
