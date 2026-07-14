import { config } from '../../config';
import { callDeviceRepo } from '../calls/call.repository';

// Push for "you've been assigned a reminder". Reuses the shared Expo push-token registry
// (push_devices, populated via /api/calls/register-device). Plain POST to Expo — no SDK/Prisma.
const isExpoPushToken = (t: string): boolean => /^Expo(nent)?PushToken\[[^\]]+\]$/.test(t);
const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

interface ExpoMessage {
  to: string;
  title: string;
  body: string;
  data: Record<string, unknown>;
  sound: 'default';
  channelId: 'default';
  priority: 'high';
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
      console.warn('[reminder-push] send error:', (e as Error).message);
    }
  }
}

// One reminder push to all of a user's devices. Tapping it (data.type 'reminder') opens the
// Reminders tab. Returns the number of devices targeted.
async function sendToUser(userId: string, title: string, text: string, reminderId: string): Promise<number> {
  const tokens = (await callDeviceRepo.tokensForUser(userId)).filter(isExpoPushToken);
  if (!tokens.length) return 0;
  const body = text.length > 90 ? `${text.slice(0, 87)}…` : text;
  const messages: ExpoMessage[] = tokens.map((to) => ({
    to,
    title,
    body,
    data: { type: 'reminder', id: reminderId },
    sound: 'default',
    channelId: 'default',
    priority: 'high',
  }));

  if (!config.push.enabled) {
    // eslint-disable-next-line no-console
    console.log(`[reminder-push] dry-run "${title}" to ${tokens.length} device(s) for ${userId}`);
    return tokens.length;
  }
  await postToExpo(messages);
  return tokens.length;
}

export const reminderPush = {
  // Assignee: `byName` created/assigned a reminder for them.
  sendAssigned: (userId: string, byName: string, text: string, reminderId: string): Promise<number> =>
    sendToUser(userId, `${byName} created a reminder for you`, text, reminderId),

  // Creator: the assignee finished it and it's awaiting review.
  sendCompleted: (userId: string, byName: string, text: string, reminderId: string): Promise<number> =>
    sendToUser(userId, `✓ ${byName} completed a reminder`, text, reminderId),

  // Assignee: the creator approved their completed reminder.
  sendApproved: (userId: string, byName: string, text: string, reminderId: string): Promise<number> =>
    sendToUser(userId, `${byName} approved your reminder`, text, reminderId),

  // Assignee: the reminder's due time arrived.
  sendDue: (userId: string, text: string, reminderId: string): Promise<number> =>
    sendToUser(userId, '⏰ Reminder due', text, reminderId),
};
