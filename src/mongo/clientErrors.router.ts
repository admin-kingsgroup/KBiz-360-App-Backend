import { Router } from 'express';
import type { RequestHandler } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../common/asyncHandler';
import { validate } from '../common/validate';
import { AppError } from '../common/errors';
import { appDb } from './connection';

// Client crash/error ingestion — the app's ErrorBoundary and fatal-error handler POST here so
// field crashes are visible without a third-party crash service. Public (crashes can happen
// before login), so payloads are tightly capped, rate-limited in-process, and expire after 30
// days via TTL. Mounted BEFORE chatRouter in app.ts (which user-JWT-gates all of /api).

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const col = () => appDb().collection('client_errors') as any;

export async function ensureClientErrorIndexes(): Promise<void> {
  await col().createIndex({ createdAt: 1 }, { expireAfterSeconds: 30 * 24 * 3600 });
  await col().createIndex({ createdAt: -1 });
}

// 30 reports/min shared bucket — a crash-looping fleet must not flood the shared Atlas tier.
let tokens = 30;
let refilledAt = Date.now();
const rateLimit: RequestHandler = (_req, _res, next) => {
  const now = Date.now();
  tokens = Math.min(30, tokens + (now - refilledAt) * (30 / 60_000));
  refilledAt = now;
  if (tokens < 1) { next(new AppError(429, 'Too many error reports', 'RATE_LIMITED')); return; }
  tokens -= 1;
  next();
};

export const clientErrorsRouter: Router = Router();

clientErrorsRouter.post(
  '/',
  rateLimit,
  validate(z.object({
    message: z.string().trim().min(1).max(500),
    stack: z.string().max(4000).optional(),
    component: z.string().max(300).optional(),
    fatal: z.boolean().optional(),
    platform: z.string().max(40).optional(),
    appVersion: z.string().max(40).optional(),
    userId: z.string().max(64).optional(),
  })),
  asyncHandler(async (req, res) => {
    await col().insertOne({ ...req.body, createdAt: new Date() });
    res.status(201).json({ ok: true });
  }),
);
