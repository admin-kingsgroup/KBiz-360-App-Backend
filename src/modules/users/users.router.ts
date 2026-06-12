import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../common/asyncHandler';
import { validate } from '../../common/validate';
import { Unauthorized } from '../../common/errors';
import { requireAuth } from '../auth/auth.middleware';
import { requireManage } from '../access/access.middleware';
import { usersService } from './users.service';
import type { UserDraft } from '../../domain/logic/validation';

export const usersRouter: Router = Router();

const roleEnum = z.enum(['SUPER_ADMIN', 'DIRECTOR', 'GENERAL_MANAGER', 'BRANCH_MANAGER', 'HOD', 'EMPLOYEE']);

// Shape validation only (non-empty email mirrors validateUserDraft — no stricter format than the app).
// Cross-field business rules stay in validateUserDraft (the verbatim ported logic).
const createSchema = z.object({
  name: z.string().min(1),
  email: z.string().min(1),
  role: roleEnum,
  bizId: z.string().nullable(),
  branches: z.array(z.string()).default([]),
  accessGroups: z.array(z.string()).default([]),
  accessDepts: z.array(z.string()).default([]),
  accessAlerts: z.array(z.string()).default([]),
});
const updateSchema = createSchema.partial();

// Reads: any authenticated user (Team/admin lists). Mutations: require canManage (Super/Director).
usersRouter.get(
  '/',
  requireAuth,
  asyncHandler(async (_req, res) => {
    res.json(await usersService.list());
  }),
);

usersRouter.get(
  '/:id',
  requireAuth,
  asyncHandler(async (req, res) => {
    res.json(await usersService.getById(req.params.id));
  }),
);

usersRouter.post(
  '/',
  requireAuth,
  requireManage,
  validate(createSchema),
  asyncHandler(async (req, res) => {
    if (!req.auth) throw Unauthorized();
    const created = await usersService.create(req.body as UserDraft, req.auth.userId);
    res.status(201).json(created);
  }),
);

usersRouter.patch(
  '/:id',
  requireAuth,
  requireManage,
  validate(updateSchema),
  asyncHandler(async (req, res) => {
    if (!req.auth) throw Unauthorized();
    const updated = await usersService.update(req.params.id, req.body as Partial<UserDraft>, req.auth.userId);
    res.json(updated);
  }),
);

usersRouter.delete(
  '/:id',
  requireAuth,
  requireManage,
  asyncHandler(async (req, res) => {
    if (!req.auth) throw Unauthorized();
    await usersService.remove(req.params.id, req.auth.userId);
    res.status(204).send();
  }),
);
