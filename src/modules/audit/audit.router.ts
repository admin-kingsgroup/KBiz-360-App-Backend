import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../common/asyncHandler';
import { validate } from '../../common/validate';
import { requireAuth } from '../auth/auth.middleware';
import { requireSuper } from '../access/access.middleware';
import { auditService } from './audit.service';

export const auditRouter: Router = Router();

const listQuery = z.object({
  entity: z.string().optional(),
  action: z.string().optional(),
  actorId: z.string().optional(),
  limit: z.coerce.number().int().optional(),
  offset: z.coerce.number().int().optional(),
});

// GET /audit — Super Admin only (audit log is a Super-only capability).
auditRouter.get(
  '/',
  requireAuth,
  requireSuper,
  validate(listQuery, 'query'),
  asyncHandler(async (req, res) => {
    res.json(await auditService.list(req.query as z.infer<typeof listQuery>));
  }),
);

// GET /audit/:id
auditRouter.get(
  '/:id',
  requireAuth,
  requireSuper,
  asyncHandler(async (req, res) => {
    res.json(await auditService.getById(req.params.id));
  }),
);
