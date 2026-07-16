import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../common/asyncHandler';
import { validate } from '../../common/validate';
import { Unauthorized, BadRequest } from '../../common/errors';
import { requireAuth, requireSuper } from '../middleware';
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

// POST /api/alerts { title, body?, recipients } → super-admin composes an announcement.
// recipients = userIds who will see it in their app; ['*'] = everyone.
alertsRouter.post(
  '/',
  requireAuth,
  requireSuper,
  validate(z.object({
    title: z.string().trim().min(1).max(160),
    body: z.string().trim().max(2000).optional(),
    recipients: z.array(z.string().min(1)).min(1).max(500),
  })),
  asyncHandler(async (req, res) => {
    if (!req.auth) throw Unauthorized();
    const { title, body, recipients } = req.body as { title: string; body?: string; recipients: string[] };
    await alertService.createAnnouncement(req.auth.userId, { title, body: body ?? '', recipients: [...new Set(recipients)] });
    res.json({ ok: true });
  }),
);

// GET /api/alerts/attachment/:eventId → { url } — auth-gated access to an event's PDF.
// Visibility mirrors the feed (supers / grant holders / addressed announcement recipients);
// S3 objects get a short-lived presigned URL so the bucket prefix can be private.
alertsRouter.get(
  '/attachment/:eventId',
  requireAuth,
  asyncHandler(async (req, res) => {
    if (!req.auth) throw Unauthorized();
    const att = await alertService.attachmentUrlFor(req.auth.userId, req.params.eventId);
    if (!att) throw BadRequest('No attachment on this event, or it is not visible to you');
    res.json(att);
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
