import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../common/asyncHandler';
import { validate } from '../../common/validate';
import { Unauthorized } from '../../common/errors';
import { requireAuth, requireManage } from '../middleware';
import { callService } from './call.service';
import { callPush } from './call.push';
import { fcmDeviceRepo } from '../../push/fcm.devices';
import { voipDeviceRepo } from '../../push/voip.devices';
import { initiateSchema, callIdSchema, registerDeviceSchema, historyQuerySchema, analyticsQuerySchema } from './call.types';

// Mounted at /api → endpoints are /api/calls/*. All require a valid access token; lifecycle routes
// are authoritative (the service fans out the matching socket events to the peer).
export const callsRouter: Router = Router();

// POST /api/calls/initiate
callsRouter.post(
  '/calls/initiate',
  requireAuth,
  validate(initiateSchema),
  asyncHandler(async (req, res) => {
    if (!req.auth) throw Unauthorized();
    const { receiverId, type } = req.body as z.infer<typeof initiateSchema>;
    res.status(201).json(await callService.initiate(req.auth.userId, receiverId, type));
  }),
);

// POST /api/calls/accept
callsRouter.post(
  '/calls/accept',
  requireAuth,
  validate(callIdSchema),
  asyncHandler(async (req, res) => {
    if (!req.auth) throw Unauthorized();
    res.json(await callService.accept(req.auth.userId, (req.body as z.infer<typeof callIdSchema>).callId));
  }),
);

// POST /api/calls/reject
callsRouter.post(
  '/calls/reject',
  requireAuth,
  validate(callIdSchema),
  asyncHandler(async (req, res) => {
    if (!req.auth) throw Unauthorized();
    res.json(await callService.reject(req.auth.userId, (req.body as z.infer<typeof callIdSchema>).callId));
  }),
);

// POST /api/calls/end
callsRouter.post(
  '/calls/end',
  requireAuth,
  validate(callIdSchema),
  asyncHandler(async (req, res) => {
    if (!req.auth) throw Unauthorized();
    res.json(await callService.end(req.auth.userId, (req.body as z.infer<typeof callIdSchema>).callId));
  }),
);

// GET /api/calls/ice-servers — WebRTC ICE config (STUN + optional TURN from env; no hardcoded creds).
callsRouter.get(
  '/calls/ice-servers',
  requireAuth,
  asyncHandler(async (_req, res) => {
    res.json({ iceServers: callService.iceServers() });
  }),
);

// GET /api/calls/history?limit&before
callsRouter.get(
  '/calls/history',
  requireAuth,
  validate(historyQuerySchema, 'query'),
  asyncHandler(async (req, res) => {
    if (!req.auth) throw Unauthorized();
    const { limit, before } = req.query as unknown as z.infer<typeof historyQuerySchema>;
    res.json({ calls: await callService.history(req.auth.userId, { limit, before }) });
  }),
);

// GET /api/calls/analytics — admin reporting (super_admin / company_manager).
callsRouter.get(
  '/calls/analytics',
  requireAuth,
  requireManage,
  validate(analyticsQuerySchema, 'query'),
  asyncHandler(async (req, res) => {
    const { from, to, userId } = req.query as unknown as z.infer<typeof analyticsQuerySchema>;
    res.json(await callService.analytics({ from, to, userId }));
  }),
);

// POST /api/calls/register-device — store the caller's Expo push token (for incoming-call pushes).
callsRouter.post(
  '/calls/register-device',
  requireAuth,
  validate(registerDeviceSchema),
  asyncHandler(async (req, res) => {
    if (!req.auth) throw Unauthorized();
    const { expoPushToken, platform } = req.body as z.infer<typeof registerDeviceSchema>;
    await callPush.registerDevice(req.auth.userId, expoPushToken, platform);
    res.status(204).send();
  }),
);

// POST /api/calls/register-fcm — store the device's RAW FCM token (for native full-screen call UI).
callsRouter.post(
  '/calls/register-fcm',
  requireAuth,
  validate(z.object({ fcmToken: z.string().min(1), platform: z.string().optional() })),
  asyncHandler(async (req, res) => {
    if (!req.auth) throw Unauthorized();
    const { fcmToken, platform } = req.body as { fcmToken: string; platform?: string };
    await fcmDeviceRepo.upsert(req.auth.userId, fcmToken, platform ?? null);
    res.status(204).send();
  }),
);

// POST /api/calls/register-voip — store the iOS device's Apple PushKit VoIP token (CallKit screen).
callsRouter.post(
  '/calls/register-voip',
  requireAuth,
  validate(z.object({ voipToken: z.string().min(1), production: z.boolean().optional() })),
  asyncHandler(async (req, res) => {
    if (!req.auth) throw Unauthorized();
    const { voipToken, production } = req.body as { voipToken: string; production?: boolean };
    await voipDeviceRepo.upsert(req.auth.userId, voipToken, production ?? true);
    res.status(204).send();
  }),
);

// GET /api/calls/:id — single call log (participant-only). Keep LAST so it doesn't shadow the
// specific routes above.
callsRouter.get(
  '/calls/:id',
  requireAuth,
  asyncHandler(async (req, res) => {
    if (!req.auth) throw Unauthorized();
    res.json(await callService.getById(req.auth.userId, req.params.id));
  }),
);
