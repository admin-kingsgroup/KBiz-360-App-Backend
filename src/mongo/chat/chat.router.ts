import { Router } from 'express';
import type { RequestHandler } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../common/asyncHandler';
import { validate } from '../../common/validate';
import { Unauthorized, Forbidden } from '../../common/errors';
import { requireAuth, requireSuper } from '../middleware';
import { chatService, canCreateGroup } from './chat.service';
import { chatAnalytics } from './chat.analytics';
import { presenceStatusOf, getLastSeen } from './chat.events';

export const chatRouter: Router = Router();
chatRouter.use(requireAuth);

// Admin analytics (Super-Admin only).
chatRouter.get('/chat/analytics', requireSuper, asyncHandler(async (_req, res) => res.json(await chatAnalytics.overview())));

// Current presence for a set of users (?userIds=a,b,c) → { [id]: { status, lastSeen } }.
chatRouter.get('/chat/presence', asyncHandler(async (req, res) => {
  const ids = String(req.query.userIds ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const out: Record<string, { status: string; lastSeen: number | null }> = {};
  for (const id of ids) out[id] = { status: presenceStatusOf(id), lastSeen: getLastSeen(id)?.getTime() ?? null };
  res.json(out);
}));
const uid = (req: { auth?: { userId: string } }): string => {
  if (!req.auth) throw Unauthorized();
  return req.auth.userId;
};

// Group creation is allowed for super-admins PLUS the delegated group-creator allowlist
// (see canCreateGroup in chat.service). Enforced server-side even though the app hides the entry
// points for everyone else.
const requireCanCreateGroup: RequestHandler = (req, _res, next) => {
  void (async () => {
    try {
      if (!req.auth) throw Unauthorized();
      if (await canCreateGroup(req.auth.userId)) { next(); return; }
      throw Forbidden('Requires super_admin');
    } catch (err) {
      next(err);
    }
  })();
};

const attachmentSchema = z.object({
  url: z.string(), name: z.string(), size: z.number(), mime: z.string(),
  width: z.number().optional(), height: z.number().optional(), durationMs: z.number().optional(),
  thumbnailUrl: z.string().optional(), waveform: z.array(z.number()).optional(),
});
const sendSchema = z.object({
  conversationId: z.string().min(1),
  type: z.enum(['text', 'image', 'video', 'document', 'voice']).optional(),
  text: z.string().optional(),
  attachments: z.array(attachmentSchema).optional(),
  replyToId: z.string().optional(),
  clientId: z.string().optional(),
  // @-mentioned userIds; the service keeps only actual participants. `forwardedFrom` is NOT
  // client-settable — zod strips it here, only forward() stamps it.
  mentions: z.array(z.string()).max(50).optional(),
});

// ── conversations ──
chatRouter.get('/conversations', asyncHandler(async (req, res) => res.json(await chatService.listConversations(uid(req)))));
chatRouter.post('/conversations', validate(z.object({ otherUserId: z.string().min(1) })), asyncHandler(async (req, res) => res.status(201).json(await chatService.getOrCreateDirect(uid(req), req.body.otherUserId))));
chatRouter.get('/conversations/:id', asyncHandler(async (req, res) => { const c = await chatService.assertAccess(uid(req), req.params.id); res.json(await chatService.conversationDTO(c, uid(req))); }));
chatRouter.get('/conversations/:id/messages', asyncHandler(async (req, res) => res.json(await chatService.getMessages(uid(req), req.params.id, { before: req.query.before as string | undefined, limit: req.query.limit ? Number(req.query.limit) : undefined }))));
chatRouter.post('/conversations/:id/read', asyncHandler(async (req, res) => res.json(await chatService.markRead(uid(req), req.params.id))));
// REST twin of the socket 'chat:delivered' ack — used by the killed/backgrounded app's push handler
// (no socket alive there) so the sender's tick turns ✓✓ the moment the push reaches the device.
chatRouter.post('/conversations/:id/delivered', asyncHandler(async (req, res) => res.json(await chatService.markDelivered(uid(req), req.params.id))));
chatRouter.get('/conversations/:id/pinned', asyncHandler(async (req, res) => res.json(await chatService.pinned(uid(req), req.params.id))));

// ── messages ──
chatRouter.post('/messages', validate(sendSchema), asyncHandler(async (req, res) => res.status(201).json(await chatService.sendMessage(uid(req), req.body.conversationId, req.body))));
chatRouter.put('/messages/:id', validate(z.object({ text: z.string().min(1) })), asyncHandler(async (req, res) => res.json(await chatService.editMessage(uid(req), req.params.id, req.body.text))));
chatRouter.delete('/messages/:id', asyncHandler(async (req, res) => {
  const scope = req.query.scope === 'everyone' ? 'everyone' : 'me';
  res.json(scope === 'everyone' ? await chatService.deleteForEveryone(uid(req), req.params.id) : await chatService.deleteForMe(uid(req), req.params.id));
}));
chatRouter.post('/messages/:id/reaction', validate(z.object({ emoji: z.string().min(1) })), asyncHandler(async (req, res) => res.json(await chatService.react(uid(req), req.params.id, req.body.emoji))));
chatRouter.post('/messages/:id/star', asyncHandler(async (req, res) => res.json(await chatService.star(uid(req), req.params.id))));
chatRouter.post('/messages/:id/pin', asyncHandler(async (req, res) => res.json(await chatService.pin(uid(req), req.params.id))));
chatRouter.post('/messages/read', validate(z.object({ conversationId: z.string().min(1) })), asyncHandler(async (req, res) => res.json(await chatService.markRead(uid(req), req.body.conversationId))));
chatRouter.post('/messages/forward', validate(z.object({ messageId: z.string().min(1), conversationIds: z.array(z.string()).min(1) })), asyncHandler(async (req, res) => res.json(await chatService.forward(uid(req), req.body.messageId, req.body.conversationIds))));
chatRouter.get('/messages/starred', asyncHandler(async (req, res) => res.json(await chatService.starred(uid(req)))));
chatRouter.get('/messages/search', asyncHandler(async (req, res) => res.json(await chatService.search(uid(req), (req.query.q as string) ?? '', { senderId: req.query.senderId as string | undefined }))));

// ── groups ──
// Creating a group is Super-Admin OR a delegated group creator (the app hides the entry points for
// everyone else, but the API must enforce it too).
chatRouter.post('/groups', requireCanCreateGroup, validate(z.object({ name: z.string().min(1), memberIds: z.array(z.string()).default([]), description: z.string().optional(), image: z.string().optional(), companyId: z.string().optional(), branchId: z.string().optional(), departmentId: z.string().optional() })), asyncHandler(async (req, res) => res.status(201).json(await chatService.createGroup(uid(req), req.body))));
// Auto branch-department group (members = the whole branch). Get-or-create, then open it.
chatRouter.post('/groups/department', validate(z.object({ branchId: z.string().min(1), departmentId: z.string().min(1), name: z.string().min(1) })), asyncHandler(async (req, res) => res.json(await chatService.getOrCreateDepartmentGroup(uid(req), req.body))));
chatRouter.get('/groups/:id', asyncHandler(async (req, res) => { const c = await chatService.assertAccess(uid(req), req.params.id); res.json(await chatService.conversationDTO(c, uid(req))); }));
chatRouter.put('/groups/:id', validate(z.object({ name: z.string().optional(), description: z.string().optional(), image: z.string().optional() })), asyncHandler(async (req, res) => res.json(await chatService.updateGroup(uid(req), req.params.id, req.body))));
chatRouter.delete('/groups/:id', asyncHandler(async (req, res) => res.json(await chatService.deleteGroup(uid(req), req.params.id))));
chatRouter.post('/groups/:id/members', validate(z.object({ memberIds: z.array(z.string()).min(1) })), asyncHandler(async (req, res) => res.json(await chatService.addMembers(uid(req), req.params.id, req.body.memberIds))));
chatRouter.delete('/groups/:id/members/:memberId', asyncHandler(async (req, res) => res.json(await chatService.removeMember(uid(req), req.params.id, req.params.memberId))));
chatRouter.post('/groups/:id/admins', validate(z.object({ memberId: z.string().min(1) })), asyncHandler(async (req, res) => res.json(await chatService.promoteAdmin(uid(req), req.params.id, req.body.memberId))));
