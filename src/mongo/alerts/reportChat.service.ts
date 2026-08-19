import { Types } from 'mongoose';
import { AppError, BadRequest } from '../../common/errors';
import { getStorage } from '../../storage';
import { crmRepo } from '../crm.repo';
import { ConversationModel, type ConversationDoc, type Attachment } from '../chat/chat.models';
import { chatService } from '../chat/chat.service';
import { attachmentFilename } from './attachmentName';
import { isFinanceGroupFor } from './financeGroupName';

// ─── Scheduled finance reports → the branch Finance GROUP CHATS ──────────────────────────
// The daily Receivables / Payables ageing PDFs and the Bank & Cash snapshot used to be pushed
// into the mobile "System Alerts" channels (Clients Receivables - <BR> etc.). They now go where
// the finance team actually talks: the per-branch group chats
//
//     HQ - BOM Finance · HQ - AMD Finance · HQ - NBO Finance · HQ - DAR Finance · HQ - FBM Finance
//
// (all five created under the MHUB hub branch). A report is an ordinary chat message from the
// reporting identity, with the PDF as a document attachment — so it is searchable, forwardable,
// repliable and it rings the same notification as any other message in that group.
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

export async function findBranchFinanceGroup(branchCode: string): Promise<{ id: string; name: string }> {
  const code = branchCode.trim().toUpperCase();
  const cached = groupCache.get(code);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return { id: cached.id, name: cached.name };

  const pinned = pinnedGroups()[code];
  if (pinned) {
    const conv = await ConversationModel().findById(pinned).select('_id name type').lean<ConversationDoc>();
    if (!conv) throw BadRequest(`REPORT_CHAT_GROUPS pins ${code} to conversation ${pinned}, which does not exist`);
    groupCache.set(code, { id: String(conv._id), name: conv.name ?? code, at: Date.now() });
    return { id: String(conv._id), name: conv.name ?? code };
  }

  // Narrow in Mongo (groups whose name mentions finance — a handful), then match exactly on the
  // squashed name in JS. A regex built from the branch code would have to guess the punctuation.
  const rows = await ConversationModel()
    .find({ type: 'group', name: { $regex: 'finance', $options: 'i' } })
    .select('_id name lastActivityAt')
    .lean<Array<Pick<ConversationDoc, '_id' | 'name' | 'lastActivityAt'>>>();
  const hits = rows.filter((r) => isFinanceGroupFor(r.name, code));
  if (!hits.length) {
    throw BadRequest(`No Finance group for branch "${code}" — expected a group named "HQ - ${code} Finance" or "${code} - Finance Team" (or pin one with REPORT_CHAT_GROUPS)`);
  }
  // Duplicates are a data accident, not a routing choice: take the one people actually use.
  hits.sort((a, b) => new Date(b.lastActivityAt ?? 0).getTime() - new Date(a.lastActivityAt ?? 0).getTime());
  const chosen = hits[0];
  if (hits.length > 1) {
    // eslint-disable-next-line no-console
    console.warn(`[report-chat] ${hits.length} groups match the Finance group name for ${code} — posting to the most recently active (${String(chosen._id)})`);
  }
  groupCache.set(code, { id: String(chosen._id), name: chosen.name ?? code, at: Date.now() });
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
  conversationId?: string; // explicit target (smoke tests, one-off posts) — wins over branchCode
  title: string;
  body?: string;
  dedupeKey?: string;
  attachment?: { name: string; mime?: string; data: string };
}

export const reportChat = {
  async post(input: ReportChatInput): Promise<{ conversationId: string; group: string; messageId: string; duplicate: boolean; attachmentUrl?: string }> {
    const target = input.conversationId
      ? await (async () => {
        const conv = await ConversationModel().findById(input.conversationId).select('_id name').lean<ConversationDoc>();
        if (!conv) throw BadRequest(`Conversation ${input.conversationId} not found`);
        return { id: String(conv._id), name: conv.name ?? String(conv._id) };
      })()
      : await findBranchFinanceGroup(input.branchCode ?? '');
    const sender = await resolveReportSender();

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
