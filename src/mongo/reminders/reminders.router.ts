import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../common/asyncHandler';
import { validate } from '../../common/validate';
import { Unauthorized } from '../../common/errors';
import { requireAuth } from '../middleware';
import { remindersService, type ReminderTab } from './reminder.service';

// Mounted at /api/reminders. Reminders run on real CRM user ids; all routes require a valid token.
export const remindersRouter: Router = Router();

const listQuery = z.object({
  tab: z.enum(['forme', 'iset', 'review', 'all', 'archive']).default('forme'),
  viewAs: z.string().optional(), // accepted for compatibility; visibility is role/level-derived
});
const createSchema = z.object({
  text: z.string().min(1),
  forId: z.string().min(1),
  when: z.string().optional(),
  section: z.string().optional(),
  dueAt: z.string().datetime({ offset: true }).optional(), // real due timestamp (ISO)
});
const patchSchema = z.object({
  action: z.enum(['complete', 'approve']).optional(),
  forId: z.string().min(1).optional(), // reassign to a different user
  text: z.string().min(1).optional(),
  when: z.string().optional(),
  section: z.string().optional(),
  dueAt: z.string().datetime({ offset: true }).optional(),
});

// GET /api/reminders?tab=forme|iset|review|all|archive
remindersRouter.get(
  '/',
  requireAuth,
  validate(listQuery, 'query'),
  asyncHandler(async (req, res) => {
    if (!req.auth) throw Unauthorized();
    const { tab } = req.query as unknown as { tab: ReminderTab };
    res.json(await remindersService.list(req.auth.userId, { tab }));
  }),
);

// POST /api/reminders
remindersRouter.post(
  '/',
  requireAuth,
  validate(createSchema),
  asyncHandler(async (req, res) => {
    if (!req.auth) throw Unauthorized();
    res.status(201).json(await remindersService.create(req.auth.userId, req.body as z.infer<typeof createSchema>));
  }),
);

// PATCH /api/reminders/:id  (action: complete | approve, or field edits)
remindersRouter.patch(
  '/:id',
  requireAuth,
  validate(patchSchema),
  asyncHandler(async (req, res) => {
    if (!req.auth) throw Unauthorized();
    res.json(await remindersService.patch(req.params.id, req.body as z.infer<typeof patchSchema>, req.auth.userId));
  }),
);

// DELETE /api/reminders/:id
remindersRouter.delete(
  '/:id',
  requireAuth,
  asyncHandler(async (req, res) => {
    if (!req.auth) throw Unauthorized();
    await remindersService.remove(req.params.id, req.auth.userId);
    res.status(204).send();
  }),
);
