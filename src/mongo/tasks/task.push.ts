import { config } from '../../config';
import { callDeviceRepo } from '../calls/call.repository';
import { TaskNotificationModel, type TaskNotificationDoc, type TaskPushRecord } from './task.model';

// The push half of a task notification, and what Expo said about it (owner, 2026-11-20). Expo answers twice:
//  1. at once, a "ticket" per phone — it accepted the message, or refused it with a reason;
//  2. about 15 minutes later, a "receipt" per accepted ticket — FCM / APNs took it, or did not
//     (DeviceNotRegistered = that phone no longer has the app).
// Both are kept on the task_notifications row (`push`). Until now the reply was thrown away, so a push that
// never arrived read exactly like one that did. Only Expo's reason CODES are kept and logged — its messages
// quote the phone's push token.

const isExpoPushToken = (t: string): boolean => /^Expo(nent)?PushToken\[[^\]]+\]$/.test(t);
const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
const EXPO_RECEIPTS_URL = 'https://exp.host/--/api/v2/push/getReceipts';

/** Receipts are asked for once a push is this old … */
export const RECEIPT_AFTER_MS = 15 * 60_000;
/** … asked for again each round while one is not ready, and recorded as missing after this long. */
export const RECEIPT_GIVE_UP_MS = 60 * 60_000;
/** Expo keeps receipts for about a day; older pushes are left unchecked. */
const RECEIPT_WINDOW_MS = 23 * 3_600_000;
const RECEIPT_ROWS_PER_ROUND = 200;
const RECEIPT_IDS_PER_CALL = 300;

export interface TaskPushMessage { title: string; body: string; data: Record<string, unknown>; urgent: boolean }

interface ExpoResult { status?: string; id?: string; details?: { error?: string } }
const reasonOf = (r: ExpoResult | undefined): string => r?.details?.error ?? 'Refused';
const uniq = (xs: string[]): string[] => [...new Set(xs)];

const headers = (): Record<string, string> => ({
  'Content-Type': 'application/json',
  Accept: 'application/json',
  ...(config.push.expoAccessToken ? { Authorization: `Bearer ${config.push.expoAccessToken}` } : {}),
});

/** POST to Expo and read its JSON. `why` says what went wrong when there is nothing usable to read. */
async function ask(url: string, body: unknown): Promise<{ json: Record<string, unknown> | null; why: string | null }> {
  let resp: Response;
  try {
    resp = await fetch(url, { method: 'POST', headers: headers(), body: JSON.stringify(body) });
  } catch {
    return { json: null, why: 'SendFailed' };
  }
  const json = (await resp.json().catch(() => null)) as Record<string, unknown> | null;
  if (!json) return { json: null, why: `HTTP ${resp.status}` };
  const errors = json.errors as Array<{ code?: string }> | undefined;
  if (!json.data && errors?.length) return { json: null, why: errors[0].code ?? `HTTP ${resp.status}` };
  return { json, why: null };
}

export const taskPush = {
  /** Push one task notification to every phone the person has registered. Null = they have none. */
  async toUser(userId: string, msg: TaskPushMessage): Promise<TaskPushRecord | null> {
    const tokens = (await callDeviceRepo.tokensForUser(userId)).filter(isExpoPushToken);
    if (!tokens.length) return null;
    const record: TaskPushRecord = { devices: tokens.length, accepted: 0, delivered: null, refused: [], ticketIds: [], checkedAt: null };
    if (!config.push.enabled) {
      // eslint-disable-next-line no-console
      console.log(`[task-push] dry-run "${msg.title}" to ${tokens.length} device(s) for ${userId}`);
      return { ...record, accepted: tokens.length };
    }
    const messages = tokens.map((to) => ({
      to,
      title: msg.title,
      body: msg.body.length > 160 ? `${msg.body.slice(0, 157)}…` : msg.body,
      data: msg.data,
      sound: 'default',
      channelId: 'general', // non-badging channel — the app-icon badge is reserved for unread chats
      priority: 'high',
      ...(msg.urgent ? { interruptionLevel: 'time-sensitive' } : {}),
    }));
    const { json, why } = await ask(EXPO_PUSH_URL, messages);
    const tickets = Array.isArray(json?.data) ? (json?.data as ExpoResult[]) : null;
    if (!tickets) {
      record.refused = [why ?? 'NoReply'];
    } else {
      const ok = tickets.filter((t) => t?.status === 'ok');
      record.accepted = ok.length;
      record.ticketIds = ok.map((t) => t.id).filter((id): id is string => !!id);
      record.refused = uniq(tickets.filter((t) => t?.status !== 'ok').map(reasonOf));
    }
    if (record.refused.length) {
      // eslint-disable-next-line no-console
      console.warn(`[task-push] "${msg.title}" for ${userId}: Expo accepted ${record.accepted} of ${record.devices} phone(s) — ${record.refused.join(', ')}`);
    }
    return record;
  },

  /**
   * Read the receipts of the task pushes that are old enough to have one, and note on each notification how
   * many phones it was delivered to. Runs from the task sweep every minute; one cheap lookup when nothing is
   * waiting. Returns how many notifications were settled.
   */
  async checkReceipts(now = new Date()): Promise<number> {
    if (!config.push.enabled) return 0;
    const waiting = await TaskNotificationModel()
      .find({
        'push.checkedAt': null,
        'push.ticketIds.0': { $exists: true },
        sentAt: { $gte: new Date(now.getTime() - RECEIPT_WINDOW_MS), $lte: new Date(now.getTime() - RECEIPT_AFTER_MS) },
      })
      .limit(RECEIPT_ROWS_PER_ROUND)
      .lean<TaskNotificationDoc[]>();
    if (!waiting.length) return 0;

    const receipts = new Map<string, ExpoResult>();
    const ids = waiting.flatMap((n) => n.push?.ticketIds ?? []);
    for (let i = 0; i < ids.length; i += RECEIPT_IDS_PER_CALL) {
      const { json } = await ask(EXPO_RECEIPTS_URL, { ids: ids.slice(i, i + RECEIPT_IDS_PER_CALL) });
      if (!json || typeof json.data !== 'object' || json.data === null) return 0; // Expo unreachable: ask again next round
      for (const [id, r] of Object.entries(json.data as Record<string, ExpoResult>)) receipts.set(id, r);
    }

    let settled = 0;
    for (const n of waiting) {
      const mine = n.push?.ticketIds ?? [];
      const known = mine.filter((id) => receipts.has(id));
      const givenUp = now.getTime() - n.sentAt.getTime() >= RECEIPT_GIVE_UP_MS;
      if (known.length < mine.length && !givenUp) continue; // a receipt is not ready yet
      const delivered = known.filter((id) => receipts.get(id)?.status === 'ok').length;
      const refused = uniq([
        ...(n.push?.refused ?? []),
        ...known.filter((id) => receipts.get(id)?.status !== 'ok').map((id) => reasonOf(receipts.get(id))),
        ...(known.length < mine.length ? ['NoReceipt'] : []),
      ]);
      await TaskNotificationModel().updateOne(
        { _id: n._id, 'push.checkedAt': null },
        { $set: { 'push.delivered': delivered, 'push.refused': refused, 'push.ticketIds': [], 'push.checkedAt': now } },
      );
      if (delivered < mine.length) {
        // eslint-disable-next-line no-console
        console.warn(`[task-push] ${n.event} to ${n.userId}: delivered to ${delivered} of ${mine.length} phone(s) — ${refused.join(', ')}`);
      }
      settled += 1;
    }
    return settled;
  },
};
