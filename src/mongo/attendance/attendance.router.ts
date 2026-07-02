import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../common/asyncHandler';
import { validate } from '../../common/validate';
import { Unauthorized } from '../../common/errors';
import { requireAuth, requireManage } from '../middleware';
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

// The caller's recent attendance (personal history list). ?days=30 (default), clamped 1..180.
attendanceRouter.get('/history', requireAuth, asyncHandler(async (req, res) => {
  if (!req.auth) throw Unauthorized();
  const days = req.query.days ? Number(req.query.days) : undefined;
  res.json(await attendanceService.history(req.auth.userId, Number.isFinite(days) ? (days as number) : undefined));
}));

// ── office geofences ──
// Offices the caller may punch at (drives the app's office picker + geofence presence).
attendanceRouter.get('/offices', requireAuth, asyncHandler(async (req, res) => {
  if (!req.auth) throw Unauthorized();
  res.json(await attendanceService.offices(req.auth.userId));
}));

// Admin: every tenant branch + its list of offices (manager-only).
attendanceRouter.get('/offices/admin', requireAuth, requireManage, asyncHandler(async (req, res) => {
  if (!req.auth) throw Unauthorized();
  res.json(await attendanceService.adminListOffices(req.auth.userId));
}));

// Admin: current per-user office assignments { [userId]: officeId } (manager-only).
attendanceRouter.get('/offices/assignments', requireAuth, requireManage, asyncHandler(async (req, res) => {
  if (!req.auth) throw Unauthorized();
  res.json(await attendanceService.listAssignments(req.auth.userId));
}));

const latLng = { lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) };
const officeFields = {
  radius: z.number().min(20).max(5000).optional(),
  label: z.string().max(80).nullable().optional(),
  address: z.string().max(200).nullable().optional(),
  wifiSsid: z.string().max(64).nullable().optional(),
  active: z.boolean().optional(),
  isDefault: z.boolean().optional(),
};

// Admin: add an office to a branch (manager-only).
attendanceRouter.post('/offices', requireAuth, requireManage,
  validate(z.object({ branchId: z.string().min(1), ...latLng, ...officeFields })),
  asyncHandler(async (req, res) => {
    if (!req.auth) throw Unauthorized();
    res.json(await attendanceService.createOffice(req.auth.userId, req.body));
  }));

// Admin: edit an office by id (manager-only).
attendanceRouter.put('/offices/id/:officeId', requireAuth, requireManage,
  validate(z.object({ lat: latLng.lat.optional(), lng: latLng.lng.optional(), ...officeFields })),
  asyncHandler(async (req, res) => {
    if (!req.auth) throw Unauthorized();
    res.json(await attendanceService.updateOffice(req.auth.userId, req.params.officeId, req.body));
  }));

// Admin: delete an office (manager-only).
attendanceRouter.delete('/offices/id/:officeId', requireAuth, requireManage, asyncHandler(async (req, res) => {
  if (!req.auth) throw Unauthorized();
  res.json(await attendanceService.deleteOffice(req.auth.userId, req.params.officeId));
}));

// Admin: make an office the branch default (manager-only).
attendanceRouter.post('/offices/id/:officeId/default', requireAuth, requireManage, asyncHandler(async (req, res) => {
  if (!req.auth) throw Unauthorized();
  res.json(await attendanceService.setDefaultOffice(req.auth.userId, req.params.officeId));
}));

// Admin: lock a user to an office (officeId null clears the assignment) (manager-only).
attendanceRouter.post('/offices/assign', requireAuth, requireManage,
  validate(z.object({ userId: z.string().min(1), officeId: z.string().nullable() })),
  asyncHandler(async (req, res) => {
    if (!req.auth) throw Unauthorized();
    res.json(await attendanceService.assignUserOffice(req.auth.userId, req.body.userId, req.body.officeId));
  }));
