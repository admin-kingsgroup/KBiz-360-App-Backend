import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../common/asyncHandler';
import { validate } from '../../common/validate';
import { Unauthorized } from '../../common/errors';
import { requireAuth } from '../auth/auth.middleware';
import { notificationsService } from './notifications.service';

export const notificationsRouter: Router = Router();

const registerSchema = z.object({
  expoPushToken: z.string().min(1),
  platform: z.string().optional(),
});

const readSchema = z.object({
  id: z.string().optional(),
  all: z.boolean().optional(),
});

// POST /notifications/register-device
notificationsRouter.post(
  '/register-device',
  requireAuth,
  validate(registerSchema),
  asyncHandler(async (req, res) => {
    if (!req.auth) throw Unauthorized();
    res.json(await notificationsService.registerDevice(req.auth.userId, req.body));
  }),
);

// GET /notifications
notificationsRouter.get(
  '/',
  requireAuth,
  asyncHandler(async (req, res) => {
    if (!req.auth) throw Unauthorized();
    res.json(await notificationsService.list(req.auth.userId));
  }),
);

// POST /notifications/read
notificationsRouter.post(
  '/read',
  requireAuth,
  validate(readSchema),
  asyncHandler(async (req, res) => {
    if (!req.auth) throw Unauthorized();
    res.json(await notificationsService.markRead(req.auth.userId, req.body));
  }),
);
