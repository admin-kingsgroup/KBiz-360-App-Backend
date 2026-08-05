import { config } from '../../config';
import { callDeviceRepo } from '../calls/call.repository';
import { fcm } from '../../push/fcm';
import { fcmDeviceRepo } from '../../push/fcm.devices';

// Chat push. PREFERRED path: high-priority FCM DATA message (same pipeline as calls) — it wakes the
// killed/backgrounded app's background handler, which updates the cached chat list + unread badge
// and draws its own notification (WhatsApp-style: the app opens with unread already in place).
// FALLBACK: Expo display push for devices that never registered an FCM token (old builds). Expo
// delivery is a plain POST to the Expo Push API (dry-run unless EXPO_PUSH_ENABLED=true). Payload
// data {type:'chat', id} → routes.ts deep-links the tap to /chat/[id].
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
  badge?: number; // iOS app-icon count (Expo forwards it as aps.badge)
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

export interface ChatPushOpts {
  title: string;
  body: string;
  mention?: boolean; // this recipient was @-mentioned — client renders the "mentioned you" line
  // Recipient's unread-chat count AFTER this message (unmuted chats with unread — the client's
  // badge formula). Rides the APNs payload so the iOS icon badge updates while the app is killed;
  // Android ignores it (the background handler recounts from the local snapshot).
  badge?: number;
  conversationId: string;
  // Rich fields for the FCM data path (background handler rebuilds the cached list entry from them).
  messageId?: string;
  senderId?: string;
  senderName?: string;
  convType?: 'direct' | 'group';
  convName?: string;
  preview?: string;
  msgType?: string;
  sentAt?: string; // ISO
  // The message ITSELF, so a local-first client can write it straight into its on-device database
  // when the push lands and have it there — from storage — before the app is even opened. `preview`
  // is truncated for the notification line and is not usable for that.
  fullText?: string;
  attachments?: unknown[];
}

// FCM caps a data payload at 4 KB. Anything at risk of blowing that is dropped (the client then
// falls back to catch-up sync) rather than truncated into a message that looks complete but isn't.
const PAYLOAD_TEXT_LIMIT = 1500;
const PAYLOAD_ATT_LIMIT = 900;

// The storable half of the payload: the complete message body and attachments, plus `full: '1'` —
// the client's permission to write this into its local database instead of just badging the chat.
// Anything oversized simply omits them, and the flag stays off.
function messagePayload(opts: ChatPushOpts): Record<string, string> {
  const out: Record<string, string> = {};
  const text = opts.fullText ?? '';
  const atts = opts.attachments?.length ? JSON.stringify(opts.attachments) : '';
  if (text.length > PAYLOAD_TEXT_LIMIT || atts.length > PAYLOAD_ATT_LIMIT) return out;
  if (text) out.text = text;
  if (atts) out.att = atts;
  out.full = '1';
  return out;
}

export const chatPush = {
  // Notify one recipient of a new message. Returns the number of devices targeted.
  async notifyNewMessage(receiverId: string, opts: ChatPushOpts): Promise<number> {
    // FCM data path first — every value must be a string (FCM requirement).
    if (fcm.isConfigured()) {
      const fcmTokens = await fcmDeviceRepo.tokensForUser(receiverId);
      if (fcmTokens.length) {
        const data: Record<string, string> = {
          type: 'chat_message',
          conversationId: opts.conversationId,
          messageId: opts.messageId ?? '',
          senderId: opts.senderId ?? '',
          senderName: opts.senderName ?? '',
          convType: opts.convType ?? 'direct',
          convName: opts.convName ?? '',
          preview: opts.preview ?? opts.body,
          msgType: opts.msgType ?? 'text',
          sentAt: opts.sentAt ?? new Date().toISOString(),
          title: opts.title,
          body: opts.body,
          mention: opts.mention ? '1' : '', // FCM data values must be strings
          ...messagePayload(opts),
        };
        let sent = 0;
        // iOS cannot run JS on data-only pushes — the apns alert makes it display the banner natively.
        for (const t of fcmTokens) if (await fcm.sendData(t, data, { title: opts.title, body: opts.body, badge: opts.badge })) sent++;
        if (sent > 0) return sent;
        // all FCM sends failed (stale tokens were pruned) → fall through to Expo
      }
    }

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
      ...(typeof opts.badge === 'number' ? { badge: Math.max(0, opts.badge) } : {}),
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
