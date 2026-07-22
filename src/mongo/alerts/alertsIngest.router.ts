import { Router } from 'express';
import type { RequestHandler } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../common/asyncHandler';
import { validate } from '../../common/validate';
import { AppError, BadRequest } from '../../common/errors';
import { getStorage } from '../../storage';
import { requireServiceToken } from './serviceAuth';
import { channelForModuleBranch } from './alertChannels';
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

// Sanitize FIRST, strip any .pdf, cap at 100, THEN append .pdf — the storage layer's own
// safeName() slice(0,120) then cannot truncate the extension away. (Appending before
// truncating let a 120-char name ending ".html" survive as the stored extension →
// served as text/html from our origin = stored XSS.)
export const attachmentFilename = (name: string): string => {
  const base = name.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/\.pdf$/i, '').slice(0, 100);
  return `${base || 'document'}.pdf`;
};

alertsIngestRouter.post(
  '/ingest',
  requireServiceToken,
  ingestRateLimit,
  validate(z.object({
    module: z.enum(['finance', 'accounts', 'crm', 'sales', 'sales-invoice']),
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
      const saved = await getStorage().save({ buffer, filename, mimeType: 'application/pdf', prefix: 'alert-attachments' });
      // key is persisted on the event doc so a future reaper can delete the stored file
      // when the event TTL-expires (the DTO exposes only {name,url}).
      stored = { name: filename, url: saved.url, key: saved.key };
    }

    // Default context embeds the branch code — the app buckets events into branch sections by it.
    const label = channel.module === 'accounts' ? 'Finance'
      : channel.module === 'sales' ? 'Sales Invoice'
        : channel.module.toUpperCase();
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
