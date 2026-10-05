import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../common/asyncHandler';
import { validate } from '../../common/validate';
import { Unauthorized } from '../../common/errors';
import { requireAuth } from '../middleware';
import { locationService, type PingInput } from './location.service';

// Mounted at /api/location. The device posts its work-hours location batches; managers read the
// live roster and a person's day trail. Role scoping lives in the service (attendance team view).
export const locationRouter: Router = Router();

// Exported for the schema regression test: validate() strips unknown keys, so every field the
// service reads MUST be listed here or it silently disappears (same trap as the punch schema).
export const pingsSchema = z.object({
  pings: z.array(z.object({
    at: z.string().datetime(),
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
    accuracy: z.number().min(0).nullable().optional(),
    speed: z.number().nullable().optional(),
    heading: z.number().nullable().optional(),
    altitude: z.number().nullable().optional(),
    source: z.enum(['bg', 'fg']).optional(),
  })).min(1).max(500),
});

locationRouter.post('/pings', requireAuth, validate(pingsSchema), asyncHandler(async (req, res) => {
  if (!req.auth) throw Unauthorized();
  res.json(await locationService.ingest(req.auth.userId, (req.body as { pings: PingInput[] }).pings));
}));

locationRouter.get('/live', requireAuth, asyncHandler(async (req, res) => {
  if (!req.auth) throw Unauthorized();
  res.json(await locationService.live(req.auth.userId));
}));

// ?date=YYYY-MM-DD (business-tz, defaults to today) browses a past day's trail.
locationRouter.get('/trail/:userId', requireAuth, asyncHandler(async (req, res) => {
  if (!req.auth) throw Unauthorized();
  const date = typeof req.query.date === 'string' && req.query.date ? req.query.date : undefined;
  res.json(await locationService.trail(req.auth.userId, req.params.userId, date));
}));
