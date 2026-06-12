import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../common/asyncHandler';
import { validate } from '../../common/validate';
import { Unauthorized } from '../../common/errors';
import { requireAuth } from '../middleware';
import { attendanceService, type PunchBody } from './attendance.service';

// Mounted at /api/attendance. The device posts punches (it owns geofence/Wi-Fi/Face detection);
// the backend persists them and serves today's status + a role-scoped team view.
export const attendanceRouter: Router = Router();

const punchSchema = z.object({
  wifiOn: z.boolean().optional(),
  coords: z.object({ lat: z.number(), lng: z.number() }).nullable().optional(),
  method: z.enum(['auto', 'face']).optional(),
});

attendanceRouter.post('/check-in', requireAuth, validate(punchSchema), asyncHandler(async (req, res) => {
  if (!req.auth) throw Unauthorized();
  res.json(await attendanceService.checkIn(req.auth.userId, req.body as PunchBody));
}));

attendanceRouter.post('/check-out', requireAuth, validate(punchSchema), asyncHandler(async (req, res) => {
  if (!req.auth) throw Unauthorized();
  res.json(await attendanceService.checkOut(req.auth.userId, req.body as PunchBody));
}));

attendanceRouter.get('/me', requireAuth, asyncHandler(async (req, res) => {
  if (!req.auth) throw Unauthorized();
  res.json(await attendanceService.me(req.auth.userId));
}));

attendanceRouter.get('/team', requireAuth, asyncHandler(async (req, res) => {
  if (!req.auth) throw Unauthorized();
  res.json(await attendanceService.team(req.auth.userId));
}));
