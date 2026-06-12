import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../common/asyncHandler';
import { validate } from '../../common/validate';
import { Unauthorized } from '../../common/errors';
import { requireAuth } from '../auth/auth.middleware';
import { remindersService, type ReminderTab } from './reminders.service';
import type { RoleKey } from '../../domain/types';

export const remindersRouter: Router = Router();

const roleEnum = z.enum(['SUPER_ADMIN', 'DIRECTOR', 'GENERAL_MANAGER', 'BRANCH_MANAGER', 'HOD', 'EMPLOYEE']);

const listQuery = z.object({
  tab: z.enum(['forme', 'iset', 'review', 'all']).default('forme'),
  viewAs: roleEnum.optional(),
});

const createSchema = z.object({
  text: z.string().min(1),
  forId: z.string().min(1),
  when: z.string().optional(),
  section: z.string().optional(),
});

const patchSchema = z.object({
  action: z.enum(['complete', 'approve']).optional(),
  text: z.string().min(1).optional(),
  when: z.string().optional(),
  section: z.string().optional(),
});

// GET /reminders?tab=forme|iset|review|all&viewAs=ROLE
remindersRouter.get(
  '/',
  requireAuth,
  validate(listQuery, 'query'),
  asyncHandler(async (req, res) => {
    if (!req.auth) throw Unauthorized();
    const q = req.query as unknown as { tab: ReminderTab; viewAs?: RoleKey };
    res.json(await remindersService.list(req.auth.userId, req.auth.role, { tab: q.tab, viewAs: q.viewAs }));
  }),
);

// POST /reminders
remindersRouter.post(
  '/',
  requireAuth,
  validate(createSchema),
  asyncHandler(async (req, res) => {
    if (!req.auth) throw Unauthorized();
    const created = await remindersService.create(req.auth.userId, req.body, req.auth.userId);
    res.status(201).json(created);
  }),
);

// PATCH /reminders/:id  (action: complete | approve, or field edits)
remindersRouter.patch(
  '/:id',
  requireAuth,
  validate(patchSchema),
  asyncHandler(async (req, res) => {
    if (!req.auth) throw Unauthorized();
    res.json(await remindersService.patch(req.params.id, req.body, req.auth.userId));
  }),
);

// DELETE /reminders/:id
remindersRouter.delete(
  '/:id',
  requireAuth,
  asyncHandler(async (req, res) => {
    if (!req.auth) throw Unauthorized();
    await remindersService.remove(req.auth.userId, req.params.id, req.auth.userId);
    res.status(204).send();
  }),
);
