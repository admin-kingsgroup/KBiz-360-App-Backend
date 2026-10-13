import { Types } from 'mongoose';
import { AppError, BadRequest } from '../../common/errors';
import { getStorage } from '../../storage';
import { crmRepo } from '../crm.repo';
import { ConversationModel, type ConversationDoc, type Attachment } from '../chat/chat.models';
import { chatService } from '../chat/chat.service';
import { attachmentFilename } from './attachmentName';
import { isCompanyWideKind, isReportGroupFor, reportGroupExpected, reportGroupNameHint, type ReportGroupKind } from './reportGroupName';
import { checkChatMedia, imageSize, mediaFilename, type ChatMediaKind } from './chatMedia';
import { stripFormatting } from '../chat/formatting';

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
// "TICKETS=<conversationId>" pins the company-wide "Ticket Support" room the same way.
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
  // A company-wide room ("Ticket Support") has no branch — whatever code the caller sent is ignored.
  const companyWide = isCompanyWideKind(kind);
  const code = companyWide ? '' : branchCode.trim().toUpperCase();
  const cacheKey = `${kind}:${code}`;
  const cached = groupCache.get(cacheKey);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return { id: cached.id, name: cached.name };

  // The pin addresses the FINANCE group (the one an operator is likely to rename); the accounts
  // family resolves by name only.
  const pinKey = companyWide ? kind.toUpperCase() : code;
  const pinned = kind === 'finance' || companyWide ? pinnedGroups()[pinKey] : undefined;
  if (pinned) {
    const conv = await ConversationModel().findById(pinned).select('_id name type').lean<ConversationDoc>();
    if (!conv) throw BadRequest(`REPORT_CHAT_GROUPS pins ${pinKey} to conversation ${pinned}, which does not exist`);
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
    throw BadRequest(companyWide
      ? `No ${kind} group — expected a group named ${reportGroupExpected(kind, code)}`
      : `No ${kind} group for branch "${code}" — expected a group named ${reportGroupExpected(kind, code)}`);
  }
  // Duplicates are a data accident, not a routing choice: take the one people actually use.
  hits.sort((a, b) => new Date(b.lastActivityAt ?? 0).getTime() - new Date(a.lastActivityAt ?? 0).getTime());
  const chosen = hits[0];
  if (hits.length > 1) {
    // eslint-disable-next-line no-console
    console.warn(`[report-chat] ${hits.length} groups match the ${kind} group name${code ? ` for ${code}` : ''} — posting to the most recently active (${String(chosen._id)})`);
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

// The person who raised a support ticket, as the account the ticket's bundle is sent from (owner,
// 2026-10-13: the bubble shows who raised it, not "KBiz Books"). Looked up by email — the ERP and
// CRM tickets carry the raiser's login email. null for an unknown email or an account that may not
// use the app (inactive, or app access switched off): the directory hides those, so every phone
// would label the bubble "Member" — the post goes out as KBiz Books instead.
export async function resolveTicketRaiser(email: string | undefined): Promise<{ id: string; name: string } | null> {
  const e = String(email ?? '').trim().toLowerCase();
  if (!e) return null;
  const user = await crmRepo.findUserByEmail(e);
  if (!user) return null;
  if (user.status && user.status !== 'active') return null;
  if (user.access?.app === false) return null;
  const name = `${user.first_name ?? ''} ${user.last_name ?? ''}`.trim() || user.email;
  return { id: String(user._id), name };
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

// Where a post goes: an explicit conversation, else the group of that kind for the branch (or the
// one company-wide room for a company-wide kind).
async function resolveTarget(input: { conversationId?: string; branchCode?: string; group?: ReportGroupKind }): Promise<{ id: string; name: string }> {
  if (input.conversationId) {
    const conv = await ConversationModel().findById(input.conversationId).select('_id name').lean<ConversationDoc>();
    if (!conv) throw BadRequest(`Conversation ${input.conversationId} not found`);
    return { id: String(conv._id), name: conv.name ?? String(conv._id) };
  }
  return findBranchReportGroup(input.branchCode ?? '', input.group ?? 'finance');
}

export interface ReportChatMediaInput {
  branchCode?: string;
  group?: ReportGroupKind;
  conversationId?: string;
  kind: ChatMediaKind; // image | voice | video | document — how the phone shows it
  caption?: string; // the line under the media, e.g. "TKT-00042 · Screenshot 1 of 3"
  durationMs?: number; // a voice note / recording's length, when the sender knows it
  dedupeKey?: string;
  dryRun?: boolean;
  file: { buffer: Buffer; name: string; mime: string };
}

export interface ReportChatBundleFile {
  kind: ChatMediaKind;
  buffer: Buffer;
  name: string;
  mime: string;
  durationMs?: number;
}

export interface ReportChatBundleInput {
  branchCode?: string;
  group?: ReportGroupKind;
  conversationId?: string;
  title: string;
  body?: string;
  dedupeKey?: string;
  dryRun?: boolean;
  files: ReportChatBundleFile[];
  // The ticket raiser's login email: the bundle is sent as their own message. Honoured for the
  // company-wide 'tickets' room only — every other room is a report feed and stays KBiz Books.
  raisedBy?: string;
}

// The chat-list / notification line for a bundle: its title, without the *bold* markers.
const bundlePreview = (title: string, count: number): string =>
  `📎 ${stripFormatting(title).trim() || `${count} file${count === 1 ? '' : 's'}`}`;

export const reportChat = {
  async post(input: ReportChatInput): Promise<{ conversationId: string; group: string; messageId: string; duplicate: boolean; dryRun?: boolean; sender?: string; attachmentUrl?: string }> {
    const target = await resolveTarget(input);
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
  // One screenshot / voice note / screen recording / PDF as its own chat message (2026-10-12, the
  // "Ticket Support" group). The file is checked BEFORE anything is resolved or stored — an
  // unsupported type or a file whose bytes are not what it claims is a 400 to the emitter.
  async postMedia(input: ReportChatMediaInput): Promise<{ conversationId: string; group: string; messageId: string; duplicate: boolean; dryRun?: boolean; sender?: string; attachmentUrl?: string }> {
    const check = checkChatMedia(input.kind, input.file.mime, input.file.buffer);
    if (!check.ok) throw BadRequest(check.error);
    const target = await resolveTarget(input);
    const sender = await resolveReportSender();
    if (input.dryRun) {
      return { conversationId: target.id, group: target.name, messageId: '', duplicate: false, dryRun: true, sender: sender.name };
    }
    const clientId = input.dedupeKey ? `report:${input.dedupeKey}` : undefined;
    // A retry of a post that landed must not store the file a second time.
    const existingId = clientId ? await chatService.findServiceMessageId(target.id, clientId) : null;
    if (existingId) return { conversationId: target.id, group: target.name, messageId: existingId, duplicate: true };

    const { buffer } = input.file;
    const filename = mediaFilename(input.file.name, check.ext);
    const saved = await getStorage().save({ buffer, filename, mimeType: check.mime });
    const attachment: Attachment = { url: saved.url, name: filename, size: buffer.length, mime: check.mime };
    if (check.kind === 'image') Object.assign(attachment, imageSize(buffer) ?? {});
    if (input.durationMs && input.durationMs > 0) attachment.durationMs = Math.round(input.durationMs);

    const sent = await chatService.postServiceMessage(target.id, sender.id, {
      text: (input.caption || '').trim(),
      attachments: [attachment],
      mediaType: check.kind,
      clientId,
      senderName: sender.name,
    });
    return { conversationId: target.id, group: target.name, messageId: sent.id, duplicate: !!sent.duplicate, attachmentUrl: saved.url };
  },
  // A support ticket as ONE chat message (owner, 2026-10-12: "4 chat msgs for one ticket — that
  // should look as one msg"): the ticket's text with every file inside the same bubble. Each file is
  // judged exactly as postMedia judges one — all of them BEFORE anything is resolved or stored, so a
  // bad file refuses the whole post rather than leaving half a ticket in the room.
  //
  // Each attachment carries its own `kind`; the message's type stays 'document'. A phone on a build
  // from before kinds existed draws every file as a document tile — still openable — instead of
  // playing a screenshot as a voice note.
  async postBundle(input: ReportChatBundleInput): Promise<{ conversationId: string; group: string; messageId: string; duplicate: boolean; dryRun?: boolean; sender?: string; attachmentUrls?: string[] }> {
    if (!input.files.length) throw BadRequest('A bundle needs at least one file');
    const checked = input.files.map((f, i) => {
      const check = checkChatMedia(f.kind, f.mime, f.buffer);
      if (!check.ok) throw BadRequest(`File ${i + 1} (${f.name || 'unnamed'}): ${check.error}`);
      return { file: f, check };
    });
    const target = await resolveTarget(input);
    // The raiser when the ticket names one the app knows; KBiz Books otherwise.
    const raiser = input.group === 'tickets' ? await resolveTicketRaiser(input.raisedBy) : null;
    const sender = raiser ?? await resolveReportSender();
    if (input.dryRun) {
      return { conversationId: target.id, group: target.name, messageId: '', duplicate: false, dryRun: true, sender: sender.name };
    }
    const clientId = input.dedupeKey ? `report:${input.dedupeKey}` : undefined;
    // A retry of a bundle that landed must not store its files a second time.
    const existingId = clientId ? await chatService.findServiceMessageId(target.id, clientId) : null;
    if (existingId) return { conversationId: target.id, group: target.name, messageId: existingId, duplicate: true };

    const attachments: Attachment[] = [];
    for (const { file, check } of checked) {
      const filename = mediaFilename(file.name, check.ext);
      const saved = await getStorage().save({ buffer: file.buffer, filename, mimeType: check.mime });
      const attachment: Attachment = { url: saved.url, name: filename, size: file.buffer.length, mime: check.mime, kind: check.kind };
      if (check.kind === 'image') Object.assign(attachment, imageSize(file.buffer) ?? {});
      if (file.durationMs && file.durationMs > 0) attachment.durationMs = Math.round(file.durationMs);
      attachments.push(attachment);
    }

    const sent = await chatService.postServiceMessage(target.id, sender.id, {
      text: [input.title, (input.body || '').trim()].filter(Boolean).join('\n'),
      attachments,
      mediaType: 'document',
      clientId,
      senderName: sender.name,
      preview: bundlePreview(input.title, attachments.length),
    });
    return { conversationId: target.id, group: target.name, messageId: sent.id, duplicate: !!sent.duplicate, sender: sender.name, attachmentUrls: attachments.map((a) => a.url) };
  },
};
