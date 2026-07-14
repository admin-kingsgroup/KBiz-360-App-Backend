import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../common/asyncHandler';
import { validate } from '../../common/validate';
import { Unauthorized, BadRequest } from '../../common/errors';
import { requireAuth } from '../middleware';
import { alertService } from './alert.service';

// System alerts — the Home "System Alerts" feed. Events are access-filtered server-side:
// super-admins see every channel; others only channels a super-admin granted them.
export const alertsRouter: Router = Router();

// GET /api/alerts → { events } visible to the caller (newest first, per-user read flag).
alertsRouter.get(
  '/',
  requireAuth,
  asyncHandler(async (req, res) => {
    if (!req.auth) throw Unauthorized();
    res.json(await alertService.listFor(req.auth.userId));
  }),
);

// POST /api/alerts/read { eventId } | { channelId } → per-user read state.
alertsRouter.post(
  '/read',
  requireAuth,
  validate(z.object({ eventId: z.string().min(1).optional(), channelId: z.string().min(1).optional() })),
  asyncHandler(async (req, res) => {
    if (!req.auth) throw Unauthorized();
    const { eventId, channelId } = req.body as { eventId?: string; channelId?: string };
    if (!eventId && !channelId) throw BadRequest('eventId or channelId is required');
    if (eventId) await alertService.markRead(req.auth.userId, eventId);
    else if (channelId) await alertService.markChannelRead(req.auth.userId, channelId);
    res.json({ ok: true });
  }),
);
