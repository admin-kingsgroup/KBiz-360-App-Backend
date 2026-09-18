import { config } from '../../config';
import { callDeviceRepo } from '../calls/call.repository';

// Push for the approval chain. Same shape as reminder.push: the shared Expo push-token registry
// (push_devices, populated via /api/calls/register-device), a plain POST to Expo. Tapping one
// carries data { type: 'approval', id } so the app can open that request's sheet.
const isExpoPushToken = (t: string): boolean => /^Expo(nent)?PushToken\[[^\]]+\]$/.test(t);
const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

interface ExpoMessage {
  to: string;
  title: string;
  body: string;
  data: Record<string, unknown>;
  sound: 'default';
  channelId: 'general'; // non-badging channel — the app-icon badge is reserved for unread chats
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
      console.warn('[approval-push] send error:', (e as Error).message);
    }
  }
}

async function sendToUser(userId: string, title: string, text: string, approvalId: string): Promise<number> {
  try {
    const tokens = (await callDeviceRepo.tokensForUser(userId)).filter(isExpoPushToken);
    if (!tokens.length) return 0;
    const body = text.length > 120 ? `${text.slice(0, 117)}…` : text;
    const messages: ExpoMessage[] = tokens.map((to) => ({
      to,
      title,
      body,
      data: { type: 'approval', id: approvalId },
      sound: 'default',
      channelId: 'general',
      priority: 'high',
    }));
    if (!config.push.enabled) {
      // eslint-disable-next-line no-console
      console.log(`[approval-push] dry-run "${title}" to ${tokens.length} device(s) for ${userId}`);
      return tokens.length;
    }
    await postToExpo(messages);
    return tokens.length;
  } catch (e) {
    // A failed push must never fail the decision that caused it.
    // eslint-disable-next-line no-console
    console.warn('[approval-push] failed:', (e as Error).message);
    return 0;
  }
}

export const approvalPush = {
  // Approver: the chain has reached them — it is their turn to decide.
  sendYourTurn: (userId: string, requesterName: string, title: string, approvalId: string): Promise<number> =>
    sendToUser(userId, `${requesterName} needs your approval`, title, approvalId),

  // Requester: one step approved, the request moved on to the next approver.
  sendStepApproved: (userId: string, byName: string, step: number, total: number, nextName: string, title: string, approvalId: string): Promise<number> =>
    sendToUser(userId, `${byName} approved · step ${step} of ${total}`, `${title} — now with ${nextName}`, approvalId),

  // Requester: the last step approved — the request is through.
  sendApproved: (userId: string, title: string, approvalId: string): Promise<number> =>
    sendToUser(userId, '✅ Request approved', title, approvalId),

  // Requester: somebody on the chain rejected it.
  sendRejected: (userId: string, byName: string, title: string, note: string, approvalId: string): Promise<number> =>
    sendToUser(userId, `❌ Rejected by ${byName}`, note ? `${title} — ${note}` : title, approvalId),
};
