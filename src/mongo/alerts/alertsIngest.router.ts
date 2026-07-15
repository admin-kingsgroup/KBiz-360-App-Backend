import { Router } from 'express';
import type { RequestHandler } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../common/asyncHandler';
import { validate } from '../../common/validate';
import { AppError, BadRequest } from '../../common/errors';
import { requireServiceToken } from './serviceAuth';
import { channelForModuleBranch } from './alertChannels';
import { alertService } from './alert.service';

// POST /api/alerts/ingest — external systems (KBiz Books ERP, CRM) push events into the
// Finance/CRM branch channels. Authenticated by the ALERTS_INGEST_TOKEN shared secret, NOT a user
// JWT — which is why this lives on its own router mounted BEFORE the /api-wide chatRouter in
// app.ts: chatRouter applies user-JWT requireAuth to every /api/* request that reaches it, and a
// service call carries no user JWT. The channel is addressed by (module, branch); unknown pairs
// 400 so an emitter misconfigured with e.g. an African branch fails loudly instead of writing to
// nowhere.
export const alertsIngestRouter: Router = Router();

// In-process token bucket: 60 events/min across all emitters. Each insert also fans a socket
// broadcast out to every connected phone (which then refetches), and alert_events lives on the
// shared Atlas cluster — so even a compromised/looping emitter must not be able to flood either.
const BUCKET_CAPACITY = 60;
const REFILL_PER_MS = BUCKET_CAPACITY / 60_000;
let bucketTokens = BUCKET_CAPACITY;
let bucketRefilledAt = Date.now();
export const ingestRateLimit: RequestHandler = (_req, _res, next) => {
  const now = Date.now();
  bucketTokens = Math.min(BUCKET_CAPACITY, bucketTokens + (now - bucketRefilledAt) * REFILL_PER_MS);
  bucketRefilledAt = now;
  if (bucketTokens < 1) {
    next(new AppError(429, 'Alert ingest rate limit exceeded — retry later', 'RATE_LIMITED'));
    return;
  }
  bucketTokens -= 1;
  next();
};

alertsIngestRouter.post(
  '/ingest',
  requireServiceToken,
  ingestRateLimit,
  validate(z.object({
    module: z.enum(['finance', 'accounts', 'crm']),
    branchCode: z.string().trim().min(2).max(10),
    title: z.string().trim().min(1).max(160),
    body: z.string().trim().max(2000).optional(),
    source: z.string().trim().min(1).max(80),
    context: z.string().trim().max(120).optional(),
  })),
  asyncHandler(async (req, res) => {
    const { module, branchCode, title, body, source, context } = req.body as {
      module: string; branchCode: string; title: string; body?: string; source: string; context?: string;
    };
    const channel = channelForModuleBranch(module, branchCode);
    if (!channel) throw BadRequest(`No alert channel for module "${module}" / branch "${branchCode}"`);
    // Default context embeds the branch code — the app buckets events into branch sections by it.
    const label = channel.module === 'accounts' ? 'Finance' : channel.module.toUpperCase();
    await alertService.record(channel.id, {
      source,
      title,
      body: body ?? '',
      context: context ?? `TK ${channel.branchCode} · ${label}`,
    });
    res.json({ ok: true, channelId: channel.id });
  }),
);
