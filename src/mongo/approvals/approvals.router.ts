import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../common/asyncHandler';
import { validate } from '../../common/validate';
import { Unauthorized } from '../../common/errors';
import { requireAuth } from '../middleware';
import { approvalService, type ApprovalScope } from './approval.service';
import { APPROVAL_LIMITS } from './approval.chain';
import type { ApprovalStatus } from './approval.model';

// Mounted at /api/approvals. Approval requests with a chain of approvers (branch manager →
// company manager → business owner). Identity is ALWAYS the verified JWT's — no route takes a
// userId for the caller, and who may see/decide a request is derived from the chain itself.
export const approvalsRouter: Router = Router();

// Exported for the router-schema regression test (validate() strips unknown keys).
export const approvalCreateSchema = z.object({
  title: z.string().trim().min(1).max(APPROVAL_LIMITS.title),
  details: z.string().trim().min(1).max(APPROVAL_LIMITS.details),
  category: z.string().trim().max(40).optional(), // omitted → read off the title ('Salary', 'Expense'…)
  approvers: z.array(z.object({ step: z.string().min(1), userId: z.string().min(1) })).min(1).max(5),
});

export const approvalDecisionSchema = z.object({
  action: z.enum(['approve', 'reject']),
  note: z.string().max(APPROVAL_LIMITS.note).optional(),
});

export const approvalListQuery = z.object({
  // all = mine + the ones that reached me · mine = I raised · assigned = reached me · actionable = my turn now
  scope: z.enum(['all', 'mine', 'assigned', 'actionable']).default('all'),
  status: z.enum(['pending', 'approved', 'rejected', 'cancelled']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

// GET /api/approvals/hierarchy — the New request form: steps + who can be picked for each.
approvalsRouter.get('/hierarchy', requireAuth, asyncHandler(async (req, res) => {
  if (!req.auth) throw Unauthorized();
  res.json(await approvalService.hierarchy(req.auth.userId));
}));

// GET /api/approvals/counts — tab badge (`actionable`) + chip counts.
approvalsRouter.get('/counts', requireAuth, asyncHandler(async (req, res) => {
  if (!req.auth) throw Unauthorized();
  res.json(await approvalService.counts(req.auth.userId));
}));

// GET /api/approvals?scope=&status=&page=&limit= — the My approvals list.
approvalsRouter.get('/', requireAuth, validate(approvalListQuery, 'query'), asyncHandler(async (req, res) => {
  if (!req.auth) throw Unauthorized();
  const q = req.query as unknown as { scope: ApprovalScope; status?: ApprovalStatus; page: number; limit: number };
  res.json(await approvalService.list(req.auth.userId, q));
}));

// POST /api/approvals — raise a request.
approvalsRouter.post('/', requireAuth, validate(approvalCreateSchema), asyncHandler(async (req, res) => {
  if (!req.auth) throw Unauthorized();
  res.status(201).json(await approvalService.create(req.auth.userId, req.body as z.infer<typeof approvalCreateSchema>));
}));

// GET /api/approvals/:id — one request with its full chain (the detail sheet).
approvalsRouter.get('/:id', requireAuth, asyncHandler(async (req, res) => {
  if (!req.auth) throw Unauthorized();
  res.json(await approvalService.get(req.auth.userId, req.params.id));
}));

// PUT /api/approvals/:id/decision { action: approve|reject, note? } — the current approver decides.
approvalsRouter.put('/:id/decision', requireAuth, validate(approvalDecisionSchema), asyncHandler(async (req, res) => {
  if (!req.auth) throw Unauthorized();
  res.json(await approvalService.decide(req.auth.userId, req.params.id, req.body as z.infer<typeof approvalDecisionSchema>));
}));

// PUT /api/approvals/:id/cancel — the requester withdraws a still-pending request.
approvalsRouter.put('/:id/cancel', requireAuth, asyncHandler(async (req, res) => {
  if (!req.auth) throw Unauthorized();
  res.json(await approvalService.cancel(req.auth.userId, req.params.id));
}));
