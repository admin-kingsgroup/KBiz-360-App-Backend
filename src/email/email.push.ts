import { config } from '../config';
import { callDeviceRepo } from '../mongo/calls/call.repository';

// New-mail push (Expo). Reuses the shared Expo token registry (push_devices). data {type:'email'}
// so a tap deep-links to the Email tab (routes.ts).
const isExpoPushToken = (t: string): boolean => /^Expo(nent)?PushToken\[[^\]]+\]$/.test(t);
const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

export const emailPush = {
  async notifyNewMail(userId: string, title: string, body: string): Promise<void> {
    const tokens = (await callDeviceRepo.tokensForUser(userId)).filter(isExpoPushToken);
    if (!tokens.length) return;
    const messages = tokens.map((to) => ({
      to,
      title: `📧 ${title}`,
      body,
      data: { type: 'email', id: 'inbox' },
      sound: 'default' as const,
      priority: 'high' as const,
      channelId: 'general' as const, // non-badging channel — badge is reserved for unread chats
    }));
    if (!config.push.enabled) {
      // eslint-disable-next-line no-console
      console.log(`[email-push] dry-run new-mail push to ${tokens.length} device(s) for ${userId}`);
      return;
    }
    try {
      await fetch(EXPO_PUSH_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...(config.push.expoAccessToken ? { Authorization: `Bearer ${config.push.expoAccessToken}` } : {}) },
        body: JSON.stringify(messages),
      });
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[email-push] send error:', (e as Error).message);
    }
  },
};
