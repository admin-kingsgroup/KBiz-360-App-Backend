import { Types } from 'mongoose';
import { AppError, BadRequest } from '../../common/errors';
import { getStorage } from '../../storage';
import { crmRepo } from '../crm.repo';
import { ConversationModel, type ConversationDoc, type Attachment } from '../chat/chat.models';
import { chatService } from '../chat/chat.service';
import { attachmentFilename } from './attachmentName';
import { isReportGroupFor, reportGroupExpected, reportGroupNameHint, type ReportGroupKind } from './reportGroupName';

// ─── Scheduled reports → the branch GROUP CHATS ───────────────────────────────────────────
// Reports that used to be one-way "System Alerts" channel events now go where the people who act
// on them actually talk, as ordinary chat messages (PDFs as document attachments) — searchable,
// forwardable, repliable, and ringing the same notification as any other message.
//
//   'finance'  → HQ - BOM Finance · HQ - AMD Finance · … (MHUB posts to "MHUB - Finance Team"):
//                daily Receivables / Payables ageing, Bank & Cash, day-close attendance.
//   'accounts' → BOM - Branch Accounts · AMD - Branch Accounts · …: the live per-voucher feed
//                (receipts, payments, contra, journals, notes, memos) as they are approved.
//
// Two lookups have to hold for a post to land, and BOTH fail loudly (4xx to the ERP, which
// dead-letters and logs) rather than writing the report somewhere else:
//   1. the group for the branch, and
//   2. the identity the message is sent as.

// REPORT_CHAT_GROUPS="BOM=<conversationId>,AMD=<conversationId>" — the escape hatch for a group
// that was renamed past recognition (or a second group with the same name). Explicit wins.
const pinnedGroups = (): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const pair of (process.env.REPORT_CHAT_GROUPS || '').split(',')) {
    const [code, id] = pair.split('=').map((s) => (s || '').trim());
    if (code && id && Types.ObjectId.isValid(id)) out[code.toUpperCase()] = id;
  }
  return out;
};

// Small caches: the 11:00 pass resolves the same five groups (and one sender) every day, and a
// manual resend fires several posts back to back. TTL keeps a rename/new group visible within
// the hour without a restart.
const CACHE_TTL_MS = 10 * 60 * 1000;
const groupCache = new Map<string, { id: string; name: string; at: number }>();
let senderCache: { id: string; name: string; at: number } | null = null;

export async function findBranchReportGroup(branchCode: string, kind: ReportGroupKind = 'finance'): Promise<{ id: string; name: string }> {
  const code = branchCode.trim().toUpperCase();
  const cacheKey = `${kind}:${code}`;
  const cached = groupCache.get(cacheKey);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return { id: cached.id, name: cached.name };

  // The pin addresses the FINANCE group (the one an operator is likely to rename); the accounts
  // family resolves by name only.
  const pinned = kind === 'finance' ? pinnedGroups()[code] : undefined;
  if (pinned) {
    const conv = await ConversationModel().findById(pinned).select('_id name type').lean<ConversationDoc>();
    if (!conv) throw BadRequest(`REPORT_CHAT_GROUPS pins ${code} to conversation ${pinned}, which does not exist`);
    groupCache.set(cacheKey, { id: String(conv._id), name: conv.name ?? code, at: Date.now() });
    return { id: String(conv._id), name: conv.name ?? code };
  }

  // Narrow in Mongo (groups whose name mentions the family — a handful), then match exactly on
  // the squashed name in JS.
  const rows = await ConversationModel()
    .find({ type: 'group', name: { $regex: reportGroupNameHint(kind), $options: 'i' } })
    .select('_id name lastActivityAt')
    .lean<Array<Pick<ConversationDoc, '_id' | 'name' | 'lastActivityAt'>>>();
  const hits = rows.filter((r) => isReportGroupFor(r.name, kind, code));
  if (!hits.length) {
    throw BadRequest(`No ${kind} group for branch "${code}" — expected a group named ${reportGroupExpected(kind, code)}`);
  }
  // Duplicates are a data accident, not a routing choice: take the one people actually use.
  hits.sort((a, b) => new Date(b.lastActivityAt ?? 0).getTime() - new Date(a.lastActivityAt ?? 0).getTime());
  const chosen = hits[0];
  if (hits.length > 1) {
    // eslint-disable-next-line no-console
    console.warn(`[report-chat] ${hits.length} groups match the ${kind} group name for ${code} — posting to the most recently active (${String(chosen._id)})`);
  }
  groupCache.set(cacheKey, { id: String(chosen._id), name: chosen.name ?? code, at: Date.now() });
  return { id: String(chosen._id), name: chosen.name ?? code };
}

// The identity the reports are sent as — a dedicated, login-less account ("KBiz Books") so the
// bubble, the push and the chat export all read as a named sender instead of an unknown id.
// It is looked up, never created here: the app's CRM connection is READ-ONLY by design
// (DB_LEAST_PRIVILEGE.md), so the account is provisioned once by scripts/ensure-report-sender.js.
export async function resolveReportSender(): Promise<{ id: string; name: string }> {
  if (senderCache && Date.now() - senderCache.at < CACHE_TTL_MS) return { id: senderCache.id, name: senderCache.name };
  const pinnedId = (process.env.REPORT_CHAT_SENDER_ID || '').trim();
  const email = (process.env.REPORT_CHAT_SENDER_EMAIL || 'kbiz.books@travkings.com').trim();
  const user = pinnedId && Types.ObjectId.isValid(pinnedId)
    ? await crmRepo.getUserById(pinnedId)
    : await crmRepo.findUserByEmail(email);
  if (!user) {
    throw new AppError(503, `Report sender "${pinnedId || email}" does not exist — run scripts/ensure-report-sender.js`, 'REPORT_SENDER_MISSING');
  }
  const name = `${user.first_name ?? ''} ${user.last_name ?? ''}`.trim() || user.email;
  senderCache = { id: String(user._id), name, at: Date.now() };
  return { id: senderCache.id, name };
}

export interface ReportChatInput {
  branchCode?: string;
  group?: ReportGroupKind; // which family of group the branch code resolves to (default 'finance')
  conversationId?: string; // explicit target (smoke tests, one-off posts) — wins over branchCode
  title: string;
  body?: string;
  dedupeKey?: string;
  // Resolve the group and the sender, report them, write nothing. The safe way to prove routing
  // on live data — an operator can check where a branch's reports would land without putting a
  // test message in front of a room full of people.
  dryRun?: boolean;
  attachment?: { name: string; mime?: string; data: string };
}

export const reportChat = {
  async post(input: ReportChatInput): Promise<{ conversationId: string; group: string; messageId: string; duplicate: boolean; dryRun?: boolean; sender?: string; attachmentUrl?: string }> {
    const target = input.conversationId
      ? await (async () => {
        const conv = await ConversationModel().findById(input.conversationId).select('_id name').lean<ConversationDoc>();
        if (!conv) throw BadRequest(`Conversation ${input.conversationId} not found`);
        return { id: String(conv._id), name: conv.name ?? String(conv._id) };
      })()
      : await findBranchReportGroup(input.branchCode ?? '', input.group ?? 'finance');
    const sender = await resolveReportSender();
    if (input.dryRun) {
      return { conversationId: target.id, group: target.name, messageId: '', duplicate: false, dryRun: true, sender: sender.name };
    }

    let attachments: Attachment[] | undefined;
    let attachmentUrl: string | undefined;
    if (input.attachment) {
      const buffer = Buffer.from(input.attachment.data, 'base64');
      if (buffer.subarray(0, 5).toString() !== '%PDF-') throw BadRequest('Attachment must be a PDF');
      const filename = attachmentFilename(input.attachment.name);
      // Saved under the PUBLIC chat-media prefix (uploads/), not the private alert-attachments/
      // one: this file is opened by the chat attachment viewer, which fetches the stored URL
      // directly and has no presign step. Same model every chat document already uses.
      const saved = await getStorage().save({ buffer, filename, mimeType: 'application/pdf' });
      attachments = [{ url: saved.url, name: filename, size: buffer.length, mime: 'application/pdf' }];
      attachmentUrl = saved.url;
    }

    const text = [input.title, (input.body || '').trim()].filter(Boolean).join('\n');
    const sent = await chatService.postServiceMessage(target.id, sender.id, {
      text,
      attachments,
      clientId: input.dedupeKey ? `report:${input.dedupeKey}` : undefined,
      senderName: sender.name,
    });
    return {
      conversationId: target.id,
      group: target.name,
      messageId: sent.id,
      duplicate: !!sent.duplicate,
      ...(attachmentUrl ? { attachmentUrl } : {}),
    };
  },
};
