import { Router, type Request } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../common/asyncHandler';
import { validate } from '../../common/validate';
import { Unauthorized } from '../../common/errors';
import { requireAuth } from '../middleware';
import { tasksService, type CreateInput, type ListQuery, type PatchInput } from './task.service';
import { DESCRIPTION_MAX, TASK_PRIORITIES, TASK_STATUSES, TITLE_MAX, type TaskStatus } from './task.types';

// Mounted at /api/tasks. Every status rule is enforced in the service, not here — these schemas only
// shape the input. There is no DELETE: tasks are never deleted, only cancelled.
export const tasksRouter: Router = Router();
tasksRouter.use(requireAuth);

const uid = (req: Request): string => {
  if (!req.auth) throw Unauthorized();
  return req.auth.userId;
};

const id24 = z.string().min(1).max(64);
const dueFields = {
  dueAt: z.string().datetime({ offset: true }).optional(),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  dueTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
};
const attachment = z.object({
  url: z.string().min(1).max(2000),
  name: z.string().min(1).max(255),
  size: z.number().int().min(0),
  mime: z.string().min(1).max(200),
});
const repeat = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('none') }),
  z.object({ kind: z.literal('daily') }),
  z.object({ kind: z.literal('weekly'), days: z.array(z.number().int().min(0).max(6)).min(1).max(7) }),
  z.object({ kind: z.literal('monthly'), dayOfMonth: z.number().int().min(1).max(31) }),
]);
const link = z.object({ label: z.string().min(1).max(120), url: z.string().min(1).max(2000) }).nullable();

const createSchema = z.object({
  title: z.string().trim().min(1).max(TITLE_MAX),
  description: z.string().max(DESCRIPTION_MAX).optional(),
  assignedTo: id24,
  watcherIds: z.array(id24).max(50).optional(),
  branchId: id24,
  companyId: id24.nullable().optional(),
  priority: z.enum(TASK_PRIORITIES as [string, ...string[]]),
  ...dueFields,
  attachments: z.array(attachment).max(20).optional(),
  repeat: repeat.optional(),
  link: link.optional(),
  source: z.enum(['app', 'erp']).optional(),
});

const csvStatuses = z
  .string()
  .optional()
  .transform((s) => (s ? s.split(',').map((x) => x.trim()).filter(Boolean) : undefined))
  .refine((arr) => !arr || arr.every((x) => (TASK_STATUSES as string[]).includes(x)), { message: 'Unknown status' });
const listQuery = z.object({
  view: z.enum(['mine', 'assigned', 'watching', 'team', 'all']).default('mine'),
  state: z.enum(['open', 'closed', 'all']).optional(),
  status: csvStatuses,
  priority: z.enum(TASK_PRIORITIES as [string, ...string[]]).optional(),
  branchId: z.string().optional(),
  companyId: z.string().optional(),
  personId: z.string().optional(),
  dueFrom: z.string().datetime({ offset: true }).optional(),
  dueTo: z.string().datetime({ offset: true }).optional(),
  q: z.string().max(200).optional(),
  flag: z.enum(['overdue', 'due_today', 'waiting_check']).optional(),
});
const statusSchema = z.object({
  to: z.enum(TASK_STATUSES as [string, ...string[]]),
  comment: z.string().max(DESCRIPTION_MAX).optional(),
  ...dueFields,
});
const reassignSchema = z.object({ assignedTo: id24, comment: z.string().max(DESCRIPTION_MAX).optional() });
const patchSchema = z.object({
  title: z.string().trim().min(1).max(TITLE_MAX).optional(),
  description: z.string().max(DESCRIPTION_MAX).optional(),
  priority: z.enum(TASK_PRIORITIES as [string, ...string[]]).optional(),
  branchId: id24.optional(),
  ...dueFields,
  repeat: repeat.optional(),
  link: link.optional(),
  comment: z.string().max(DESCRIPTION_MAX).optional(),
});
const watchersSchema = z.object({ add: z.array(id24).max(50).optional(), remove: z.array(id24).max(50).optional() });
const pageQuery = z.object({
  before: z.string().optional(),
  after: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});
const dashboardQuery = z.object({ companyId: z.string().optional(), branchId: z.string().optional() });
const openedSchema = z.object({ ids: z.array(z.string()).max(200).optional() });

tasksRouter.post('/', validate(createSchema), asyncHandler(async (req, res) => {
  res.status(201).json(await tasksService.create(uid(req), req.body as CreateInput));
}));

tasksRouter.get('/', validate(listQuery, 'query'), asyncHandler(async (req, res) => {
  res.json(await tasksService.list(uid(req), req.query as unknown as ListQuery));
}));

tasksRouter.get('/dashboard', validate(dashboardQuery, 'query'), asyncHandler(async (req, res) => {
  res.json(await tasksService.dashboard(uid(req), req.query as { companyId?: string; branchId?: string }));
}));

tasksRouter.get('/notifications', asyncHandler(async (req, res) => {
  res.json(await tasksService.notifications(uid(req)));
}));

tasksRouter.post('/notifications/opened', validate(openedSchema), asyncHandler(async (req, res) => {
  res.json({ opened: await tasksService.markNotificationsOpened(uid(req), (req.body as { ids?: string[] }).ids ?? null) });
}));

tasksRouter.get('/:id', asyncHandler(async (req, res) => {
  res.json(await tasksService.get(uid(req), req.params.id));
}));

tasksRouter.patch('/:id', validate(patchSchema), asyncHandler(async (req, res) => {
  res.json(await tasksService.patch(uid(req), req.params.id, req.body as PatchInput));
}));

tasksRouter.post('/:id/status', validate(statusSchema), asyncHandler(async (req, res) => {
  const body = req.body as { to: TaskStatus; comment?: string; dueAt?: string; dueDate?: string; dueTime?: string };
  res.json(await tasksService.changeStatus(uid(req), req.params.id, body));
}));

tasksRouter.post('/:id/reassign', validate(reassignSchema), asyncHandler(async (req, res) => {
  res.json(await tasksService.reassign(uid(req), req.params.id, req.body as { assignedTo: string; comment?: string }));
}));

tasksRouter.post('/:id/watchers', validate(watchersSchema), asyncHandler(async (req, res) => {
  res.json(await tasksService.watchers(uid(req), req.params.id, req.body as { add?: string[]; remove?: string[] }));
}));

tasksRouter.post('/:id/attachments', validate(attachment), asyncHandler(async (req, res) => {
  res.status(201).json(await tasksService.addAttachment(uid(req), req.params.id, req.body as z.infer<typeof attachment>));
}));

tasksRouter.post('/:id/chat', asyncHandler(async (req, res) => {
  res.json(await tasksService.ensureChat(uid(req), req.params.id));
}));

tasksRouter.get('/:id/messages', validate(pageQuery, 'query'), asyncHandler(async (req, res) => {
  res.json(await tasksService.messages(uid(req), req.params.id, req.query as { before?: string; after?: string; limit?: number }));
}));
