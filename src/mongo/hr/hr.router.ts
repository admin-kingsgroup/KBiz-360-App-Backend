import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../common/asyncHandler';
import { validate } from '../../common/validate';
import { Unauthorized } from '../../common/errors';
import { requireAuth, requireSuper } from '../middleware';
import { leaveService } from './leave.service';
import { regularizationService } from './regularization.service';
import { myMonthService } from './myMonth.service';

// Mounted at /api/hr. Self-service HR for the app: paid-leave balance + applications (shared
// with the ERP's approval queue) and attendance regularisation requests (approved in-app by a
// manager). Identity is ALWAYS the verified JWT's — no route takes a userId for the self half.
export const hrRouter: Router = Router();

// Exported for the router-schema regression test (validate() strips unknown keys).
export const leaveApplySchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  reason: z.string().min(1).max(500),
  // Half-day (one day, the other half worked). Must be declared or validate() strips it and a
  // half ask silently files as a FULL day — the exact trap the ERP's old validator had.
  dayType: z.enum(['full', 'half']).optional(),
});

// checkOutAt:null (an explicit "leave today open") must survive parsing — same trap as the
// admin times schema: omitting `.nullable()` would silently drop the field.
export const regularizationSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  checkInAt: z.string().datetime(),
  checkOutAt: z.string().datetime().nullable().optional(),
  reason: z.string().min(1).max(300),
});

export const regularizationDecisionSchema = z.object({
  action: z.enum(['approve', 'reject']),
  note: z.string().max(300).optional(),
});

// ── paid leave (balance + applications; HR approves on the ERP) ──
hrRouter.get('/my-leave', requireAuth, asyncHandler(async (req, res) => {
  if (!req.auth) throw Unauthorized();
  res.json(await leaveService.myLeave(req.auth.userId));
}));

hrRouter.post('/my-leave', requireAuth, validate(leaveApplySchema), asyncHandler(async (req, res) => {
  if (!req.auth) throw Unauthorized();
  res.status(201).json(await leaveService.applyLeave(req.auth.userId, req.body));
}));

hrRouter.put('/my-leave/:id/cancel', requireAuth, asyncHandler(async (req, res) => {
  if (!req.auth) throw Unauthorized();
  res.json(await leaveService.cancelLeave(req.auth.userId, req.params.id));
}));

// ── self-service month views (identity ALWAYS the JWT's — no userId parameter) ──
hrRouter.get('/my-attendance', requireAuth, asyncHandler(async (req, res) => {
  if (!req.auth) throw Unauthorized();
  res.json(await myMonthService.myAttendance(req.auth.userId, String(req.query.month ?? '').trim()));
}));

hrRouter.get('/my-payslip', requireAuth, asyncHandler(async (req, res) => {
  if (!req.auth) throw Unauthorized();
  res.json(await myMonthService.myPayslip(req.auth.userId, String(req.query.month ?? '').trim()));
}));

hrRouter.get('/holidays', requireAuth, asyncHandler(async (req, res) => {
  if (!req.auth) throw Unauthorized();
  res.json(await myMonthService.myHolidays(req.auth.userId, String(req.query.year ?? '').trim()));
}));

// ── attendance regularisation (requested here, approved here by a manager) ──
hrRouter.get('/regularizations', requireAuth, asyncHandler(async (req, res) => {
  if (!req.auth) throw Unauthorized();
  res.json(await regularizationService.myRequests(req.auth.userId));
}));

hrRouter.post('/regularizations', requireAuth, validate(regularizationSchema), asyncHandler(async (req, res) => {
  if (!req.auth) throw Unauthorized();
  res.status(201).json(await regularizationService.request(req.auth.userId, req.body));
}));

hrRouter.put('/regularizations/:id/cancel', requireAuth, asyncHandler(async (req, res) => {
  if (!req.auth) throw Unauthorized();
  res.json(await regularizationService.cancel(req.auth.userId, req.params.id));
}));

// Super-admin queue + decision. Approving a request WRITES the day's times, so it carries the
// same gate as the direct editor (owner rule 2026-09-08: only the super admin changes a recorded
// time). The service re-checks isSuper and the tenant, like the attendance admin paths.
hrRouter.get('/regularizations/pending', requireAuth, requireSuper, asyncHandler(async (req, res) => {
  if (!req.auth) throw Unauthorized();
  res.json(await regularizationService.pendingForAdmin(req.auth.userId));
}));

hrRouter.put('/regularizations/:id/decision', requireAuth, requireSuper, validate(regularizationDecisionSchema), asyncHandler(async (req, res) => {
  if (!req.auth) throw Unauthorized();
  res.json(await regularizationService.decide(req.auth.userId, req.params.id, req.body));
}));
