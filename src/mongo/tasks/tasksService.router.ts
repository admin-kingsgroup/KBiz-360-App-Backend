import { Router, type Request } from 'express';
import { Types } from 'mongoose';
import { z } from 'zod';
import { asyncHandler } from '../../common/asyncHandler';
import { validate } from '../../common/validate';
import { BadRequest, Forbidden } from '../../common/errors';
import { getStorage } from '../../storage';
import { crmRepo, type CrmUser } from '../crm.repo';
import { requireServiceToken } from '../alerts/serviceAuth';
import { userPositions } from '../userPositions';
import { tasksService, type ListQuery } from './task.service';
import { taskPeople } from './task.people';
import { DESCRIPTION_MAX, TASK_DEPARTMENTS, TASK_PRIORITIES, TASK_STATUSES, TITLE_MAX, type TaskDepartment, type TaskPriority, type TaskStatus } from './task.types';

// /api/service/tasks — the door KBiz Books (the ERP) uses to create Smart Connect tasks (owner,
// 2026-11-16: "right-click in the ERP creates a task"). Same arrangement as /api/service/reminders:
// the shared service secret (ALERTS_INGEST_TOKEN) instead of a user JWT, mounted BEFORE the /api-wide
// chatRouter, and the signed-in ERP user named in `X-Act-As` (their id in the shared users
// collection). Every call runs through the unchanged tasksService AS that person — the same rules,
// chat, history, pushes and emails as a task made in the app. App access is not required: someone
// who only works in the ERP can still give a task.
export const tasksServiceRouter: Router = Router();
tasksServiceRouter.use(requireServiceToken);

const nameOf = (u: CrmUser): string => `${u.first_name ?? ''} ${u.last_name ?? ''}`.trim() || u.email || 'Unknown';

async function actor(req: Request): Promise<CrmUser> {
  const raw = req.headers['x-act-as'];
  const id = (Array.isArray(raw) ? raw[0] : raw ?? '').trim();
  if (!id) throw BadRequest('X-Act-As (the acting user id) is required');
  const user = await crmRepo.getUserById(id);
  if (!user) throw Forbidden('Acting user not found');
  if (user.status && user.status !== 'active') throw Forbidden('Acting user is not active');
  return user;
}

const SCREENSHOT_MIMES = ['image/png', 'image/jpeg', 'image/webp'] as const;
const MAX_SCREENSHOT_B64 = 8_000_000; // ≈ 6 MB decoded — a cropped screenshot is far below this

const createSchema = z.object({
  title: z.string().trim().min(1).max(TITLE_MAX),
  description: z.string().max(DESCRIPTION_MAX).optional(),
  assignedTo: z.string().min(1).max(64),
  watcherIds: z.array(z.string().min(1).max(64)).max(50).optional(),
  branchId: z.string().min(1).max(64),
  priority: z.enum(TASK_PRIORITIES as [string, ...string[]]),
  // Operations / Accounts — the branch group the task is shared in (owner, 2026-11-19).
  department: z.enum(TASK_DEPARTMENTS as [string, ...string[]]).optional(),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  dueTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
  // The ERP screen the task is about — opened from the task in the app.
  link: z.object({ label: z.string().trim().min(1).max(120), url: z.string().url().max(2000).refine((u) => /^https?:\/\//i.test(u), 'http(s) only') }).optional(),
  image: z.object({
    mime: z.enum(SCREENSHOT_MIMES),
    data: z.string().min(1).max(MAX_SCREENSHOT_B64), // base64, no data: prefix
  }).optional(),
});

// GET /api/service/tasks/people — everyone in the acting user's company a task can be given to. `app`
// says whether they have the app (a task still reaches them by email and in the ERP otherwise).
tasksServiceRouter.get('/people', asyncHandler(async (req, res) => {
  const me = await actor(req);
  const users = await crmRepo.listUsers(me.tenant_id ? { tenant_id: me.tenant_id } : {});
  const active = users.filter((u) => !u.status || u.status === 'active');
  const positions = await userPositions.mapFor(active.map((u) => String(u._id)));
  res.json(
    active
      .map((u) => ({ id: String(u._id), name: nameOf(u), email: u.email, position: positions[String(u._id)] ?? null, app: u.access?.app === true }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  );
}));

// GET /api/service/tasks/branches — the business / branch list a task is filed under (CRM branches;
// the ERP matches its own book code to `code`).
tasksServiceRouter.get('/branches', asyncHandler(async (req, res) => {
  const me = await actor(req);
  const tenant = me.tenant_id ? { tenant_id: me.tenant_id } : {};
  const branches = (await crmRepo.listBranches(tenant)).filter((b) => !b.status || b.status === 'active');
  const companyIds = [...new Set(branches.map((b) => (b.company_id ? String(b.company_id) : '')).filter(Boolean))];
  const companies = companyIds.length ? await crmRepo.listCompanies({ _id: { $in: companyIds.map((c) => new Types.ObjectId(c)) } }) : [];
  const companyName = new Map(companies.map((c) => [String(c._id), c.name]));
  res.json(
    branches
      .map((b) => ({
        id: String(b._id),
        code: b.code ?? null,
        name: b.name ?? b.code ?? 'Branch',
        companyId: b.company_id ? String(b.company_id) : null,
        companyName: b.company_id ? companyName.get(String(b.company_id)) ?? null : null,
      }))
      .sort((a, b) => String(a.companyName ?? '').localeCompare(String(b.companyName ?? '')) || a.name.localeCompare(b.name)),
  );
}));

// POST /api/service/tasks — a task given from the ERP, optionally with a screenshot (stored once, kept
// on the task as a file) and a link back to the ERP screen it is about.
tasksServiceRouter.post('/', validate(createSchema), asyncHandler(async (req, res) => {
  const me = await actor(req);
  const body = req.body as z.infer<typeof createSchema>;
  const attachments: Array<{ url: string; name: string; size: number; mime: string }> = [];
  if (body.image) {
    const buffer = Buffer.from(body.image.data, 'base64');
    if (!buffer.length) throw BadRequest('The screenshot is empty');
    const ext = body.image.mime === 'image/jpeg' ? 'jpg' : body.image.mime === 'image/webp' ? 'webp' : 'png';
    const name = `erp-screenshot.${ext}`;
    const saved = await getStorage().save({ buffer, filename: name, mimeType: body.image.mime });
    attachments.push({ url: saved.url, name, size: buffer.length, mime: body.image.mime });
  }
  const task = await tasksService.create(String(me._id), {
    title: body.title,
    description: body.description,
    assignedTo: body.assignedTo,
    watcherIds: body.watcherIds,
    branchId: body.branchId,
    priority: body.priority as TaskPriority,
    department: (body.department as TaskDepartment | undefined) ?? null,
    dueDate: body.dueDate,
    dueTime: body.dueTime,
    link: body.link ?? null,
    attachments,
    source: 'erp',
  });
  res.status(201).json(task);
}));

// ── The ERP's Task tab (owner, 2026-11-20: "the task view of my Smart Connect app in my ERP") ──
// Read the lists, open one task, move its status — the same tasksService calls the app's /api/tasks
// makes, AS the acting user, so who-may-see and who-may-do stay the app's rules. No chat, edit or
// reassign here yet: those stay in the app. The fixed paths are declared before '/:id'.
const listQuery = z.object({
  view: z.enum(['mine', 'assigned', 'watching', 'team', 'all']).default('mine'),
  state: z.enum(['open', 'closed', 'all']).optional(),
  personId: z.string().max(64).optional(),
  q: z.string().max(200).optional(),
});
const dashboardQuery = z.object({ companyId: z.string().max(64).optional(), branchId: z.string().max(64).optional() });
const statusSchema = z.object({
  to: z.enum(TASK_STATUSES as [string, ...string[]]),
  comment: z.string().max(DESCRIPTION_MAX).optional(),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  dueTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
});

// GET /api/service/tasks/dashboard — the per-person counts behind the Team list.
tasksServiceRouter.get('/dashboard', validate(dashboardQuery, 'query'), asyncHandler(async (req, res) => {
  const me = await actor(req);
  res.json(await tasksService.dashboard(String(me._id), req.query as { companyId?: string; branchId?: string }));
}));

// GET /api/service/tasks?view=mine|assigned|watching|team|all&state=open|closed — one list.
tasksServiceRouter.get('/', validate(listQuery, 'query'), asyncHandler(async (req, res) => {
  const me = await actor(req);
  res.json(await tasksService.list(String(me._id), req.query as unknown as ListQuery));
}));

// GET /api/service/tasks/:id — the task and its history (refused if the acting user may not see it).
tasksServiceRouter.get('/:id', asyncHandler(async (req, res) => {
  const me = await actor(req);
  res.json(await tasksService.get(String(me._id), req.params.id));
}));

// ── The task's chat in the ERP (owner, 2026-11-20: "task chat inside the ERP as well") ──
// Start it, read it, write in it, mark it read — as the acting user, by the app's own rules (only someone on
// the task writes; a manager above reads; a closed task's chat is read-only). The ERP has no socket, so it
// asks for new messages with `after` (the last id it holds). Each message carries its sender's name.
const messagesQuery = z.object({
  after: z.string().max(64).optional(),
  before: z.string().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});
const CHAT_FILE_MIMES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'application/pdf'] as const;
const messageSchema = z.object({
  text: z.string().max(4000).optional(),
  clientId: z.string().max(64).optional(),
  file: z.object({
    name: z.string().trim().min(1).max(255),
    mime: z.enum(CHAT_FILE_MIMES),
    data: z.string().min(1).max(MAX_SCREENSHOT_B64), // base64, no data: prefix — ≈ 6 MB decoded
  }).optional(),
}).refine((b) => !!(b.text && b.text.trim()) || !!b.file, { message: 'Write a message or attach a file' });

async function withSenderNames<T extends { senderId: string }>(msgs: T[]): Promise<Array<T & { senderName: string }>> {
  const people = await taskPeople.resolve([...new Set(msgs.map((m) => m.senderId).filter(Boolean))]);
  return msgs.map((m) => ({ ...m, senderName: people.get(m.senderId)?.name ?? 'Someone' }));
}

// POST /api/service/tasks/:id/chat — "Start chat" (or the existing chat's id).
tasksServiceRouter.post('/:id/chat', asyncHandler(async (req, res) => {
  const me = await actor(req);
  res.json(await tasksService.ensureChat(String(me._id), req.params.id));
}));

// GET /api/service/tasks/:id/messages?after=|before=&limit= — oldest first; [] while no chat was started.
tasksServiceRouter.get('/:id/messages', validate(messagesQuery, 'query'), asyncHandler(async (req, res) => {
  const me = await actor(req);
  const msgs = await tasksService.messages(String(me._id), req.params.id, req.query as { after?: string; before?: string; limit?: number });
  res.json(await withSenderNames(msgs as Array<{ senderId: string }>));
}));

// POST /api/service/tasks/:id/messages — { text?, file?: { name, mime, data }, clientId? }.
tasksServiceRouter.post('/:id/messages', validate(messageSchema), asyncHandler(async (req, res) => {
  const me = await actor(req);
  const body = req.body as z.infer<typeof messageSchema>;
  const attachments: Array<{ url: string; name: string; size: number; mime: string }> = [];
  if (body.file) {
    const buffer = Buffer.from(body.file.data, 'base64');
    if (!buffer.length) throw BadRequest('The file is empty');
    const saved = await getStorage().save({ buffer, filename: body.file.name, mimeType: body.file.mime });
    attachments.push({ url: saved.url, name: body.file.name, size: buffer.length, mime: body.file.mime });
  }
  const msg = await tasksService.sendChatMessage(String(me._id), req.params.id, { text: body.text?.trim() || '', attachments, clientId: body.clientId });
  res.status(201).json((await withSenderNames([msg as { senderId: string }]))[0]);
}));

// POST /api/service/tasks/:id/read — clears the acting user's unread on the task's chat.
tasksServiceRouter.post('/:id/read', asyncHandler(async (req, res) => {
  const me = await actor(req);
  res.json(await tasksService.markChatRead(String(me._id), req.params.id));
}));

// POST /api/service/tasks/:id/status — one status change; the app's machine decides if it is allowed.
tasksServiceRouter.post('/:id/status', validate(statusSchema), asyncHandler(async (req, res) => {
  const me = await actor(req);
  const body = req.body as { to: TaskStatus; comment?: string; dueDate?: string; dueTime?: string };
  res.json(await tasksService.changeStatus(String(me._id), req.params.id, body));
}));
