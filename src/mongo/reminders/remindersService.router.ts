import { Router, type Request } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../common/asyncHandler';
import { validate } from '../../common/validate';
import { BadRequest, Forbidden } from '../../common/errors';
import { getStorage } from '../../storage';
import { crmRepo, type CrmUser } from '../crm.repo';
import { requireServiceToken } from '../alerts/serviceAuth';
import { userPositions } from '../userPositions';
import { remindersService, type ReminderTab } from './reminder.service';

// /api/service/reminders — the door KBiz Books (the ERP) uses to read and write the SAME reminders
// the app shows, so a reminder raised on either side is one record seen on both. Authenticated by
// the shared service secret (ALERTS_INGEST_TOKEN — the one the ERP already holds for alerts), NOT a
// user JWT, so this router is mounted BEFORE the /api-wide chatRouter like the alert ingest.
//
// The ERP has already authenticated its user; it names them in `X-Act-As` (their id in the shared
// users collection) and every call runs through the unchanged remindersService AS that person —
// the same visibility, the same state machine, the same socket events and pushes as the app. App
// access is deliberately not required: someone who only works in the ERP can still set and receive
// reminders there.
export const remindersServiceRouter: Router = Router();
remindersServiceRouter.use(requireServiceToken);

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

const listQuery = z.object({ tab: z.enum(['forme', 'iset', 'review', 'all', 'archive']).default('forme') });
const createSchema = z.object({
  text: z.string().min(1).max(4000),
  forIds: z.array(z.string().min(1)).min(1).max(50),
  when: z.string().max(80).optional(),
  dueAt: z.string().datetime({ offset: true }).optional(),
  image: z.object({
    mime: z.enum(SCREENSHOT_MIMES),
    data: z.string().min(1).max(MAX_SCREENSHOT_B64), // base64, no data: prefix
  }).optional(),
});
const patchSchema = z.object({
  action: z.enum(['complete', 'approve']).optional(),
  forId: z.string().min(1).optional(),
  text: z.string().min(1).max(4000).optional(),
  when: z.string().max(80).optional(),
  dueAt: z.string().datetime({ offset: true }).optional(),
});

// GET /api/service/reminders?tab= — the acting user's reminders, same shape as GET /api/reminders.
remindersServiceRouter.get(
  '/',
  validate(listQuery, 'query'),
  asyncHandler(async (req, res) => {
    const me = await actor(req);
    const { tab } = req.query as unknown as { tab: ReminderTab };
    res.json(await remindersService.list(String(me._id), { tab }));
  }),
);

// GET /api/service/reminders/people — everyone in the acting user's company a reminder can be set
// for (the @-mention list). `app` says whether the person can open the app, so the ERP can show
// who will get it on their phone and who will only see it in the ERP.
remindersServiceRouter.get(
  '/people',
  asyncHandler(async (req, res) => {
    const me = await actor(req);
    const users = await crmRepo.listUsers(me.tenant_id ? { tenant_id: me.tenant_id } : {});
    const active = users.filter((u) => !u.status || u.status === 'active');
    const positions = await userPositions.mapFor(active.map((u) => String(u._id)));
    res.json(
      active
        .map((u) => ({ id: String(u._id), name: nameOf(u), email: u.email, position: positions[String(u._id)] ?? null, app: u.access?.app === true }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    );
  }),
);

// POST /api/service/reminders — one reminder per person in forIds; an optional screenshot is
// stored once and shared by all of them.
remindersServiceRouter.post(
  '/',
  validate(createSchema),
  asyncHandler(async (req, res) => {
    const me = await actor(req);
    const body = req.body as z.infer<typeof createSchema>;
    let imageUrl: string | undefined;
    if (body.image) {
      const buffer = Buffer.from(body.image.data, 'base64');
      if (!buffer.length) throw BadRequest('The screenshot is empty');
      const ext = body.image.mime === 'image/jpeg' ? 'jpg' : body.image.mime === 'image/webp' ? 'webp' : 'png';
      imageUrl = (await getStorage().save({ buffer, filename: `reminder-screenshot.${ext}`, mimeType: body.image.mime })).url;
    }
    const records = await remindersService.create(String(me._id), {
      text: body.text, forIds: body.forIds, when: body.when, dueAt: body.dueAt, imageUrl, source: 'erp',
    });
    res.status(201).json(records);
  }),
);

// PATCH /api/service/reminders/:id — complete (assignee) / approve (creator) / reassign / edit.
remindersServiceRouter.patch(
  '/:id',
  validate(patchSchema),
  asyncHandler(async (req, res) => {
    const me = await actor(req);
    res.json(await remindersService.patch(req.params.id, req.body as z.infer<typeof patchSchema>, String(me._id)));
  }),
);

// DELETE /api/service/reminders/:id — creator or a manager.
remindersServiceRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const me = await actor(req);
    await remindersService.remove(req.params.id, String(me._id));
    res.status(204).send();
  }),
);
