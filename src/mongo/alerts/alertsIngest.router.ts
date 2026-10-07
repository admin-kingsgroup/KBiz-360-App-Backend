import { Router } from 'express';
import type { RequestHandler } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../common/asyncHandler';
import { validate } from '../../common/validate';
import { AppError, BadRequest } from '../../common/errors';
import { getStorage } from '../../storage';
import { crmRepo } from '../crm.repo';
import { requireServiceToken } from './serviceAuth';
import { ALERT_GROUP_BY_MODULE, channelForKgd, channelForModuleBranch, USER_ALERTS_CHANNEL_ID } from './alertChannels';
import { attachmentFilename } from './attachmentName';
import { contactSchema, type AlertContact } from './alertContact';
import { reportChat } from './reportChat.service';
import { alertService } from './alert.service';

// POST /api/alerts/ingest — external systems (KBiz Books ERP, CRM) push events into the
// Finance/CRM/Sales-Invoice branch channels. Authenticated by the ALERTS_INGEST_TOKEN shared secret, NOT a user
// JWT — which is why this lives on its own router mounted BEFORE the /api-wide chatRouter in
// app.ts: chatRouter applies user-JWT requireAuth to every /api/* request that reaches it, and a
// service call carries no user JWT. The channel is addressed by (module, branch); unknown pairs
// 400 so an emitter misconfigured with e.g. an African branch fails loudly instead of writing to
// nowhere. KGD Alerts (module 'kgd-tickets', 2026-10-07) are addressed by (module, system) instead —
// a ticket belongs to the CRM or the ERP, not to a branch.
export const alertsIngestRouter: Router = Router();

// In-process token bucket: bursts up to 120 (a bulk approve-many fires one invoice alert per
// booking), sustained 60/min across all emitters. Each insert also fans a socket broadcast out
// to every connected phone (which then refetches), and alert_events lives on the shared Atlas
// cluster — so even a compromised/looping emitter must not be able to flood either. Requests
// carrying an attachment are charged EXTRA tokens proportional to payload size, so the bucket
// bounds BYTES (≈ 60 × ATTACH_COST_UNIT/min into storage), not just event count.
const BUCKET_CAPACITY = 120;
const REFILL_PER_MS = 60 / 60_000;
const ATTACH_COST_UNIT = 64_000; // base64 chars per extra token (≈48 KB decoded)
let bucketTokens = BUCKET_CAPACITY;
let bucketRefilledAt = Date.now();
export const ingestRateLimit: RequestHandler = (req, _res, next) => {
  const now = Date.now();
  bucketTokens = Math.min(BUCKET_CAPACITY, bucketTokens + (now - bucketRefilledAt) * REFILL_PER_MS);
  bucketRefilledAt = now;
  const b64Len = (req.body as { attachment?: { data?: string } } | undefined)?.attachment?.data?.length ?? 0;
  const cost = 1 + Math.ceil(b64Len / ATTACH_COST_UNIT);
  if (bucketTokens < cost) {
    next(new AppError(429, 'Alert ingest rate limit exceeded — retry later', 'RATE_LIMITED'));
    return;
  }
  bucketTokens -= cost;
  next();
};

// PDF attachments (e.g. the ERP's approved-booking invoice): base64 in the JSON body.
// A generated invoice is ~100-300 KB, so 1.5 MB decoded is generous headroom while
// keeping the worst-case bytes a token holder can push far below the old 10 MB cap.
// Only PDFs are accepted — enforced by the %PDF- magic bytes AND a stored filename
// that is GUARANTEED to end in .pdf after sanitization (the extension decides the
// Content-Type express.static serves, so it must never be attacker-controllable).
const MAX_ATTACHMENT_B64 = 2_000_000; // ≈ 1.5 MB decoded

// Re-exported for the ingest's own use and for the callers/tests that have always imported it
// from here; the implementation moved to ./attachmentName so the Finance-group chat post can
// share the exact same rule without importing this router (a cycle).
export { attachmentFilename } from './attachmentName';

// The card's "Open" button (added 2026-10-07 — first for KGD tickets, accepted from every module):
// an absolute https URL only, so the app never opens a javascript:, data: or plain-http link.
export const linkSchema = z.string().trim().max(500)
  .url('link must be a URL')
  .refine((v) => v.startsWith('https://'), { message: 'link must start with https://' });

alertsIngestRouter.post(
  '/ingest',
  requireServiceToken,
  ingestRateLimit,
  validate(z.object({
    // Everything except the legacy Finance and CRM families was retired 2026-08-19 — those
    // reports go to the branch group chats via /chat below, and an emitter still aiming here must
    // fail loudly rather than write into a feed nobody reads. Added 2026-09-27: 'leads' (CRM),
    // 'erp' (ERP), 'erp-reports' (ERP Reports), 'crm-reports' (CRM Reports). HR (attendance) is
    // written by this backend itself, so it is not ingestable. Added 2026-10-07: 'kgd-tickets'
    // (KGD Alerts) — addressed by `system`, not by branch.
    module: z.enum(['finance', 'accounts', 'crm', 'leads', 'erp', 'erp-reports', 'crm-reports', 'kgd-tickets']),
    // Required (2–10 chars) for every branch module — refine below; ignored for kgd-tickets, which
    // has no branch (so whatever the emitter sends there, null included, never fails the post).
    branchCode: z.string().trim().max(40).nullish(),
    // kgd-tickets only, and required there: which system the ticket was raised in.
    system: z.enum(['crm', 'erp']).optional(),
    title: z.string().trim().min(1).max(160),
    body: z.string().trim().max(2000).optional(),
    source: z.string().trim().min(1).max(80),
    context: z.string().trim().max(120).optional(),
    // Idempotency, unique per channel ("ar-BOM-2026-09-27"): a re-fired cron slot or a retry
    // records nothing the second time and answers { duplicate: true }.
    dedupeKey: z.string().trim().min(1).max(120).optional(),
    attachment: z.object({
      name: z.string().trim().min(1).max(120),
      mime: z.literal('application/pdf').optional(),
      data: z.string().min(1).max(MAX_ATTACHMENT_B64),
    }).optional(),
    // Someone to reach from the card — the CRM sends the converted lead's client. Stored with the
    // event and shown as WhatsApp + Call buttons; never part of the push text.
    contact: contactSchema.optional(),
    // What the card opens (e.g. the ticket in the CRM / ERP). Stored with the event; never pushed.
    link: linkSchema.optional(),
  })
    .refine((v) => v.module !== 'kgd-tickets' || !!v.system, { message: 'system (crm | erp) is required for kgd-tickets', path: ['system'] })
    .refine((v) => v.module === 'kgd-tickets' || (!!v.branchCode && v.branchCode.length >= 2 && v.branchCode.length <= 10), { message: 'branchCode is required', path: ['branchCode'] })),
  asyncHandler(async (req, res) => {
    const { module, branchCode, system, title, body, source, context, attachment, dedupeKey, contact, link } = req.body as {
      module: string; branchCode?: string | null; system?: 'crm' | 'erp'; title: string; body?: string; source: string; context?: string;
      attachment?: { name: string; mime?: string; data: string }; dedupeKey?: string; contact?: AlertContact; link?: string;
    };
    const channel = module === 'kgd-tickets' ? channelForKgd(system as 'crm' | 'erp') : channelForModuleBranch(module, branchCode ?? '');
    if (!channel) throw BadRequest(`No alert channel for module "${module}" / branch "${branchCode}"`);
    // Cheap early answer for a repeat, before any PDF is uploaded (record() still guards the race).
    if (dedupeKey && await alertService.hasEvent(channel.id, dedupeKey)) {
      res.json({ ok: true, channelId: channel.id, duplicate: true });
      return;
    }

    let stored: { name: string; url: string; key: string } | undefined;
    if (attachment) {
      const buffer = Buffer.from(attachment.data, 'base64');
      if (buffer.subarray(0, 5).toString() !== '%PDF-') throw BadRequest('Attachment must be a PDF');
      const filename = attachmentFilename(attachment.name);
      // Dedicated S3 prefix: invoice PDFs carry customer GSTIN/amounts — a bucket policy can
      // make alert-attachments/* private (served via the auth-gated signed-URL endpoint)
      // without touching the public chat-media uploads/* prefix.
      let saved;
      try {
        saved = await getStorage().save({ buffer, filename, mimeType: 'application/pdf', prefix: 'alert-attachments' });
      } catch (e) {
        // The private prefix needs the bucket user to hold s3:Put/Get/DeleteObject on
        // alert-attachments/* — until IAM grants that, store under the public-but-unguessable
        // uploads/ prefix (the chat-media model, where these PDFs lived pre-2026-07-16) instead
        // of dropping the attachment. Once IAM is fixed the primary path takes over silently.
        console.error('[alerts-ingest] alert-attachments save failed — falling back to uploads/:', (e as Error).message);
        saved = await getStorage().save({ buffer, filename, mimeType: 'application/pdf' });
      }
      // key is persisted on the event doc so a future reaper can delete the stored file
      // when the event TTL-expires (the DTO exposes only {name,url}).
      stored = { name: filename, url: saved.url, key: saved.key };
    }

    // Default context embeds the branch code — the app buckets events into branch sections by it.
    // KGD Alerts have no branch: their sections are the two systems ("KGD · CRM tickets").
    const label = ALERT_GROUP_BY_MODULE[channel.module] ?? channel.module.toUpperCase();
    const defaultContext = channel.companyWide
      ? `KGD · ${system === 'erp' ? 'ERP' : 'CRM'} tickets`
      : `TK ${channel.branchCode} · ${label}`;
    const { duplicate } = await alertService.record(channel.id, {
      source,
      title,
      body: body ?? '',
      context: context ?? defaultContext,
      ...(stored ? { attachment: stored } : {}),
      ...(contact ? { contact: { ...(contact.name ? { name: contact.name } : {}), phone: contact.phone } } : {}),
      ...(link ? { link } : {}),
    }, null, dedupeKey);
    res.json({ ok: true, channelId: channel.id, ...(duplicate ? { duplicate: true } : {}), ...(stored && !duplicate ? { attachmentUrl: stored.url } : {}) });
  }),
);

// POST /api/alerts/user — the same service-token pipe, addressed to ONE person instead of a
// branch: the event lands in their personal "My Alerts" (nobody else sees it) and pushes to their
// phone alone. Added 2026-09-30 for the CRM's "a lead / query was assigned to you" (owner: "notify
// that user on CRM and Smart Connect both"). `userId` is the shared `users` _id the CRM already
// holds. A user who is inactive or barred from the app gets nothing — answered `skipped`, not an
// error, so the CRM's reassign never trips over it.
alertsIngestRouter.post(
  '/user',
  requireServiceToken,
  ingestRateLimit,
  validate(z.object({
    userId: z.string().trim().regex(/^[a-f0-9]{24}$/i, 'userId must be a user id'),
    title: z.string().trim().min(1).max(160),
    body: z.string().trim().max(2000).optional(),
    source: z.string().trim().min(1).max(80),
    context: z.string().trim().max(120).optional(),
    contact: contactSchema.optional(),
  })),
  asyncHandler(async (req, res) => {
    const { userId, title, body, source, context, contact } = req.body as {
      userId: string; title: string; body?: string; source: string; context?: string; contact?: AlertContact;
    };
    const user = await crmRepo.getUserById(userId);
    if (!user) throw BadRequest(`No user ${userId}`);
    if (user.status && user.status !== 'active') {
      res.json({ ok: true, skipped: 'inactive' });
      return;
    }
    if (user.access?.app === false) {
      res.json({ ok: true, skipped: 'no-app-access' });
      return;
    }
    await alertService.recordUserAlert(userId, {
      source,
      title,
      body: body ?? '',
      context: context ?? source,
      ...(contact ? { contact: { ...(contact.name ? { name: contact.name } : {}), phone: contact.phone } } : {}),
    });
    res.json({ ok: true, channelId: USER_ALERTS_CHANNEL_ID });
  }),
);

// POST /api/alerts/chat — the same service-token pipe, but the event lands in a branch's GROUP
// CHAT instead of an alert channel. Since 2026-08-19 this is where every report the app used to
// carry as one-way alerts goes: 'finance' → "HQ - <BR> Finance" (daily ageing PDFs, Bank & Cash,
// the day-close attendance summary), 'accounts' → "<BR> - Branch Accounts" (the per-voucher money
// feed), 'ticketing'/'holidays' → "<BR> - Ticketing" / "<BR> - Holidays" (approved invoices and
// SO/PO/GP deals, split by module), 'inb-ticketing'/'inb-holidays' → the "INB <desk> A/B" room the
// two branches of a deal share. Addressed by branch (resolved to the group by name) or,
// for a one-off post, by an explicit conversationId. `dedupeKey` makes a re-fired cron slot or a
// retry idempotent; `dryRun` reports where a post WOULD land without writing anything.
alertsIngestRouter.post(
  '/chat',
  requireServiceToken,
  ingestRateLimit,
  validate(z.object({
    // A single code, or "SELLER/BUYER" for the INB kinds (the pair groups two branches share).
    branchCode: z.string().trim().min(2).max(16).optional(),
    group: z.enum(['finance', 'accounts', 'ticketing', 'holidays', 'inb-ticketing', 'inb-holidays']).optional(),
    conversationId: z.string().trim().regex(/^[a-f0-9]{24}$/i).optional(),
    dryRun: z.boolean().optional(),
    title: z.string().trim().min(1).max(300),
    body: z.string().trim().max(4000).optional(),
    source: z.string().trim().min(1).max(80).optional(),
    dedupeKey: z.string().trim().max(120).optional(),
    attachment: z.object({
      name: z.string().trim().min(1).max(120),
      mime: z.literal('application/pdf').optional(),
      data: z.string().min(1).max(MAX_ATTACHMENT_B64),
    }).optional(),
  }).refine((v) => !!(v.branchCode || v.conversationId), { message: 'branchCode or conversationId is required' })),
  asyncHandler(async (req, res) => {
    const { branchCode, group, conversationId, dryRun, title, body, dedupeKey, attachment } = req.body as {
      branchCode?: string; group?: 'finance' | 'accounts' | 'ticketing' | 'holidays' | 'inb-ticketing' | 'inb-holidays';
      conversationId?: string; dryRun?: boolean;
      title: string; body?: string; dedupeKey?: string; attachment?: { name: string; mime?: string; data: string };
    };
    const out = await reportChat.post({ branchCode, group, conversationId, dryRun, title, body, dedupeKey, attachment });
    res.json({ ok: true, ...out });
  }),
);
