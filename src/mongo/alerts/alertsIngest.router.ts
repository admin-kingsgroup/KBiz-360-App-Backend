import { Router } from 'express';
import type { RequestHandler } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../common/asyncHandler';
import { validate } from '../../common/validate';
import { AppError, BadRequest } from '../../common/errors';
import { getStorage } from '../../storage';
import { requireServiceToken } from './serviceAuth';
import { channelForModuleBranch } from './alertChannels';
import { attachmentFilename } from './attachmentName';
import { reportChat } from './reportChat.service';
import { alertService } from './alert.service';

// POST /api/alerts/ingest — external systems (KBiz Books ERP, CRM) push events into the
// Finance/CRM/Sales-Invoice branch channels. Authenticated by the ALERTS_INGEST_TOKEN shared secret, NOT a user
// JWT — which is why this lives on its own router mounted BEFORE the /api-wide chatRouter in
// app.ts: chatRouter applies user-JWT requireAuth to every /api/* request that reaches it, and a
// service call carries no user JWT. The channel is addressed by (module, branch); unknown pairs
// 400 so an emitter misconfigured with e.g. an African branch fails loudly instead of writing to
// nowhere.
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

alertsIngestRouter.post(
  '/ingest',
  requireServiceToken,
  ingestRateLimit,
  validate(z.object({
    // Everything except the legacy Finance and CRM families was retired 2026-08-19 — those
    // reports go to the branch group chats via /chat below, and an emitter still aiming here must
    // fail loudly rather than write into a feed nobody reads.
    module: z.enum(['finance', 'accounts', 'crm']),
    branchCode: z.string().trim().min(2).max(10),
    title: z.string().trim().min(1).max(160),
    body: z.string().trim().max(2000).optional(),
    source: z.string().trim().min(1).max(80),
    context: z.string().trim().max(120).optional(),
    attachment: z.object({
      name: z.string().trim().min(1).max(120),
      mime: z.literal('application/pdf').optional(),
      data: z.string().min(1).max(MAX_ATTACHMENT_B64),
    }).optional(),
  })),
  asyncHandler(async (req, res) => {
    const { module, branchCode, title, body, source, context, attachment } = req.body as {
      module: string; branchCode: string; title: string; body?: string; source: string; context?: string;
      attachment?: { name: string; mime?: string; data: string };
    };
    const channel = channelForModuleBranch(module, branchCode);
    if (!channel) throw BadRequest(`No alert channel for module "${module}" / branch "${branchCode}"`);

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
    const MODULE_LABEL: Record<string, string> = { accounts: 'Finance' };
    const label = MODULE_LABEL[channel.module] ?? channel.module.toUpperCase();
    await alertService.record(channel.id, {
      source,
      title,
      body: body ?? '',
      context: context ?? `TK ${channel.branchCode} · ${label}`,
      ...(stored ? { attachment: stored } : {}),
    });
    res.json({ ok: true, channelId: channel.id, ...(stored ? { attachmentUrl: stored.url } : {}) });
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
