import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../common/asyncHandler';
import { validate } from '../common/validate';
import { Unauthorized } from '../common/errors';
import { requireAuth, requireSuper } from './middleware';
import { accessService } from './access';
import { directoryService } from './directory.service';
import { appAccess } from './appAccess';
import { userPositions } from './userPositions';
import { attendanceExempt } from './attendanceExempt';
import { mongoAuth } from './auth';
import { emitToUser } from './chat/chat.events';

// Super-admin only: control which users may use the app.
export const adminRouter: Router = Router();

// GET /api/admin/user-access → { [userId]: enabled } for every user the super-admin can see.
adminRouter.get(
  '/user-access',
  requireAuth,
  requireSuper,
  asyncHandler(async (req, res) => {
    if (!req.auth) throw Unauthorized();
    const access = await accessService.accessForUserId(req.auth.userId);
    if (!access) throw Unauthorized();
    const users = await directoryService.listUsers(access);
    res.json(await appAccess.statesFor(users.map((u) => u.id)));
  }),
);

// POST /api/admin/user-access { userId, enabled } → toggle a user's app access.
// Disabling: revoke their refresh sessions + push an instant "logged out" to any live app.
adminRouter.post(
  '/user-access',
  requireAuth,
  requireSuper,
  validate(z.object({ userId: z.string().min(1), enabled: z.boolean() })),
  asyncHandler(async (req, res) => {
    if (!req.auth) throw Unauthorized();
    const { userId, enabled } = req.body as { userId: string; enabled: boolean };
    await appAccess.setEnabled(userId, enabled, req.auth.userId);
    if (!enabled) {
      await mongoAuth.revokeAllSessions(userId);
      emitToUser(userId, 'auth:revoked', { reason: 'access_disabled' });
    }
    res.json({ ok: true });
  }),
);

// POST /api/admin/positions { userId, position } → set a user's display job title (blank clears it).
adminRouter.post(
  '/positions',
  requireAuth,
  requireSuper,
  validate(z.object({ userId: z.string().min(1), position: z.string().max(120) })),
  asyncHandler(async (req, res) => {
    if (!req.auth) throw Unauthorized();
    const { userId, position } = req.body as { userId: string; position: string };
    await userPositions.setPosition(userId, position, req.auth.userId);
    res.json({ ok: true });
  }),
);

// GET /api/admin/attendance-tracking → { [userId]: tracked } for every user the super-admin can see.
adminRouter.get(
  '/attendance-tracking',
  requireAuth,
  requireSuper,
  asyncHandler(async (req, res) => {
    if (!req.auth) throw Unauthorized();
    const access = await accessService.accessForUserId(req.auth.userId);
    if (!access) throw Unauthorized();
    const users = await directoryService.listUsers(access);
    res.json(await attendanceExempt.statesFor(users.map((u) => u.id)));
  }),
);

// POST /api/admin/attendance-tracking { userId, tracked } → toggle whether a user's attendance is taken.
adminRouter.post(
  '/attendance-tracking',
  requireAuth,
  requireSuper,
  validate(z.object({ userId: z.string().min(1), tracked: z.boolean() })),
  asyncHandler(async (req, res) => {
    if (!req.auth) throw Unauthorized();
    const { userId, tracked } = req.body as { userId: string; tracked: boolean };
    await attendanceExempt.setExempt(userId, !tracked, req.auth.userId);
    res.json({ ok: true });
  }),
);
