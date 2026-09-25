import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../common/asyncHandler';
import { validate } from '../../common/validate';
import { Unauthorized } from '../../common/errors';
import { requireAuth } from '../middleware';
import { approvalService, type ApprovalCreateBody, type ApprovalScope } from './approval.service';
import { APPROVAL_LIMITS } from './approval.chain';
import type { ApprovalStatus } from './approval.model';

// Mounted at /api/approvals. Approval requests with a chain of LEVELS the requester builds (any
// number, one or more approvers each), travelled strictly in order. Identity is ALWAYS the
// verified JWT's — no route takes a userId for the caller, and who may see/decide a request is
// derived from the chain itself.
export const approvalsRouter: Router = Router();

// Exported for the router-schema regression test (validate() strips unknown keys).
const approvalLevelSchema = z.object({
  label: z.string().trim().max(APPROVAL_LIMITS.label).optional(), // omitted → "Level n"
  mode: z.enum(['all', 'any']).optional(), // omitted → all
  approverIds: z.array(z.string().trim().min(1)).min(1).max(APPROVAL_LIMITS.approversPerLevel),
});

export const approvalCreateSchema = z
  .object({
    title: z.string().trim().min(1).max(APPROVAL_LIMITS.title),
    details: z.string().trim().min(1).max(APPROVAL_LIMITS.details),
    category: z.string().trim().max(40).optional(), // omitted → read off the title ('Salary', 'Expense'…)
    levels: z.array(approvalLevelSchema).min(1).max(APPROVAL_LIMITS.levels).optional(),
    // LEGACY (pre-N-level app build): one pick per fixed role step.
    approvers: z.array(z.object({ step: z.string().min(1), userId: z.string().min(1) })).min(1).max(5).optional(),
  })
  .refine((b) => !!b.levels || !!b.approvers, { message: 'Add at least one approval level', path: ['levels'] });

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

export const approverSearchQuery = z.object({
  q: z.string().trim().max(80).optional(), // matches name, email, role, job title, branch code
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

// GET /api/approvals/hierarchy — the New request form: level-builder limits, pickable people,
// a suggested role-based chain (+ the fixed role steps for the previous app build).
approvalsRouter.get('/hierarchy', requireAuth, asyncHandler(async (req, res) => {
  if (!req.auth) throw Unauthorized();
  res.json(await approvalService.hierarchy(req.auth.userId));
}));

// GET /api/approvals/approvers?q=&limit= — the people picker for a level.
approvalsRouter.get('/approvers', requireAuth, validate(approverSearchQuery, 'query'), asyncHandler(async (req, res) => {
  if (!req.auth) throw Unauthorized();
  res.json(await approvalService.approvers(req.auth.userId, req.query as unknown as { q?: string; limit: number }));
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

// POST /api/approvals — raise a request with its levels.
approvalsRouter.post('/', requireAuth, validate(approvalCreateSchema), asyncHandler(async (req, res) => {
  if (!req.auth) throw Unauthorized();
  res.status(201).json(await approvalService.create(req.auth.userId, req.body as ApprovalCreateBody));
}));

// GET /api/approvals/:id — one request with its full chain (the detail sheet).
approvalsRouter.get('/:id', requireAuth, asyncHandler(async (req, res) => {
  if (!req.auth) throw Unauthorized();
  res.json(await approvalService.get(req.auth.userId, req.params.id));
}));

// PUT /api/approvals/:id/decision { action: approve|reject, note? } — an approver whose turn it is decides.
approvalsRouter.put('/:id/decision', requireAuth, validate(approvalDecisionSchema), asyncHandler(async (req, res) => {
  if (!req.auth) throw Unauthorized();
  res.json(await approvalService.decide(req.auth.userId, req.params.id, req.body as z.infer<typeof approvalDecisionSchema>));
}));

// PUT /api/approvals/:id/cancel — the requester withdraws a still-pending request.
approvalsRouter.put('/:id/cancel', requireAuth, asyncHandler(async (req, res) => {
  if (!req.auth) throw Unauthorized();
  res.json(await approvalService.cancel(req.auth.userId, req.params.id));
}));
