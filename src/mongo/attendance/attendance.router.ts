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

// Exported for the router-schema regression test (source must survive validation).
export const punchSchema = z.object({
  wifiOn: z.boolean().optional(), // legacy, ignored
  wifiSsid: z.string().max(64).nullable().optional(),
  coords: z.object({ lat: z.number(), lng: z.number() }).nullable().optional(),
  method: z.enum(['auto', 'face']).optional(),
  // 'geofence' = punch fired by the headless OS geofence task; drives the check-out drift guard.
  // MUST be listed here — validate() strips unknown keys, so omitting it silently disabled the guard.
  source: z.enum(['geofence']).optional(),
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

// ?date=YYYY-MM-DD (business-tz, defaults to today) lets the admin browse past days.
attendanceRouter.get('/team', requireAuth, asyncHandler(async (req, res) => {
  if (!req.auth) throw Unauthorized();
  const date = typeof req.query.date === 'string' && req.query.date ? req.query.date : undefined;
  res.json(await attendanceService.team(req.auth.userId, date));
}));

// The caller's recent attendance (personal history list). ?days=30 (default), clamped 1..180.
attendanceRouter.get('/history', requireAuth, asyncHandler(async (req, res) => {
  if (!req.auth) throw Unauthorized();
  const days = req.query.days ? Number(req.query.days) : undefined;
  res.json(await attendanceService.history(req.auth.userId, Number.isFinite(days) ? (days as number) : undefined));
}));

// A teammate's recent attendance (per-user history for the admin team view). Manager-only;
// the service additionally checks the target belongs to the viewer's tenant. ?days as above.
attendanceRouter.get('/history/user/:userId', requireAuth, requireManage, asyncHandler(async (req, res) => {
  if (!req.auth) throw Unauthorized();
  const days = req.query.days ? Number(req.query.days) : undefined;
  res.json(await attendanceService.historyForUserAsAdmin(req.auth.userId, req.params.userId, Number.isFinite(days) ? (days as number) : undefined));
}));

// Admin correction — mark a user present/absent for one day (manager-only; audit-stamped).
attendanceRouter.post('/admin/day', requireAuth, requireManage,
  validate(z.object({
    userId: z.string().min(1),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    present: z.boolean(),
    inTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
    outTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
  })),
  asyncHandler(async (req, res) => {
    if (!req.auth) throw Unauthorized();
    res.json(await attendanceService.adminSetDay(req.auth.userId, req.body));
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

// ── working branch (where each user marks attendance) ──
// Admin: current per-user working-branch assignments { [userId]: branchId } (manager-only).
attendanceRouter.get('/work-branches', requireAuth, requireManage, asyncHandler(async (req, res) => {
  if (!req.auth) throw Unauthorized();
  res.json(await attendanceService.listWorkBranchAssignments(req.auth.userId));
}));

// Admin: set a user's working branch (branchId null clears → first CRM access branch) (manager-only).
attendanceRouter.post('/work-branches/assign', requireAuth, requireManage,
  validate(z.object({ userId: z.string().min(1), branchId: z.string().nullable() })),
  asyncHandler(async (req, res) => {
    if (!req.auth) throw Unauthorized();
    res.json(await attendanceService.assignUserWorkBranch(req.auth.userId, req.body.userId, req.body.branchId));
  }));

// Admin: lock a user to an office (officeId null clears the assignment) (manager-only).
attendanceRouter.post('/offices/assign', requireAuth, requireManage,
  validate(z.object({ userId: z.string().min(1), officeId: z.string().nullable() })),
  asyncHandler(async (req, res) => {
    if (!req.auth) throw Unauthorized();
    res.json(await attendanceService.assignUserOffice(req.auth.userId, req.body.userId, req.body.officeId));
  }));
