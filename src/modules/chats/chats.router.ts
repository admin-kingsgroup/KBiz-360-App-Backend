import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../common/asyncHandler';
import { validate } from '../../common/validate';
import { Unauthorized } from '../../common/errors';
import { requireAuth } from '../auth/auth.middleware';
import { chatsService } from './chats.service';

export const chatsRouter: Router = Router();

const postMessageSchema = z.object({
  chatId: z.string().min(1),
  body: z.string().min(1),
});

// GET /chats — global DM list (not access-filtered) + caller's unread total.
chatsRouter.get(
  '/chats',
  requireAuth,
  asyncHandler(async (req, res) => {
    if (!req.auth) throw Unauthorized();
    res.json(await chatsService.list(req.auth.userId));
  }),
);

// GET /chats/:id/messages
chatsRouter.get(
  '/chats/:id/messages',
  requireAuth,
  asyncHandler(async (req, res) => {
    res.json(await chatsService.messages(req.params.id));
  }),
);

// POST /chats/:id/read — clear the caller's unread for this chat.
chatsRouter.post(
  '/chats/:id/read',
  requireAuth,
  asyncHandler(async (req, res) => {
    if (!req.auth) throw Unauthorized();
    await chatsService.markRead(req.auth.userId, req.params.id);
    res.status(204).send();
  }),
);

// POST /messages
chatsRouter.post(
  '/messages',
  requireAuth,
  validate(postMessageSchema),
  asyncHandler(async (req, res) => {
    if (!req.auth) throw Unauthorized();
    const { chatId, body } = req.body as z.infer<typeof postMessageSchema>;
    res.status(201).json(await chatsService.postMessage(req.auth.userId, chatId, body));
  }),
);
