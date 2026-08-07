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
import { fetchLinkPreview } from './chat.linkPreview';
import { statusService } from './chat.status';

export const chatRouter: Router = Router();
chatRouter.use(requireAuth);

// Admin analytics (Super-Admin only).
chatRouter.get('/chat/analytics', requireSuper, asyncHandler(async (_req, res) => res.json(await chatAnalytics.overview())));

// Catch-up sync for local-first clients: everything that changed across MY conversations since the
// watermark (?since=<iso>&limit=). Replaces the per-chat refetch — the app calls this on connect and
// then reads messages straight off the device. A missing/invalid `since` is rejected rather than
// silently treated as epoch, which would stream the user's entire history back.
chatRouter.get('/chat/sync', asyncHandler(async (req, res) => {
  const raw = String(req.query.since ?? '');
  const since = new Date(raw);
  if (!raw || Number.isNaN(since.getTime())) { res.status(400).json({ error: 'since (ISO date) is required' }); return; }
  const sinceId = req.query.sinceId ? String(req.query.sinceId) : undefined;
  const limit = req.query.limit ? Number(req.query.limit) : undefined;
  res.json(await chatService.syncSince(uid(req), since, sinceId, limit));
}));

// Current presence for a set of users (?userIds=a,b,c) → { [id]: { status, lastSeen } }.
chatRouter.get('/chat/presence', asyncHandler(async (req, res) => {
  const ids = String(req.query.userIds ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const me = uid(req);
  const out: Record<string, { status: string; lastSeen: number | null }> = {};
  // "Last seen" privacy, WhatsApp's way: hidden from everyone when the owner turned it off, and
  // hidden in both directions across a block. Online/offline still resolves — only the timestamp is
  // withheld, so the client falls back to "last seen recently".
  const settings = await Promise.all(ids.map(async (id) => ({ id, s: await chatService.getPrivacy(id) })));
  const mine = await chatService.getPrivacy(me);
  for (const { id, s } of settings) {
    const blocked = mine.blocked.includes(id) || s.blocked.includes(me);
    const share = id === me || (s.lastSeen === 'everyone' && !blocked);
    out[id] = { status: blocked && id !== me ? 'offline' : presenceStatusOf(id), lastSeen: share ? getLastSeen(id)?.getTime() ?? null : null };
  }
  res.json(out);
}));

// ── per-chat settings: mute (optionally timed), archive, pin ──
chatRouter.patch('/conversations/:id/settings', validate(z.object({
  muted: z.boolean().optional(),
  muteHours: z.number().positive().nullable().optional(), // absent/null with muted ⇒ "Always"
  archived: z.boolean().optional(),
  pinned: z.boolean().optional(),
})), asyncHandler(async (req, res) => res.json(await chatService.setConversationSettings(uid(req), req.params.id, req.body))));

// ── disappearing messages (per chat; group admins only in groups) ──
chatRouter.patch('/conversations/:id/disappearing', validate(z.object({ seconds: z.number().int().nullable() })), asyncHandler(async (req, res) =>
  res.json(await chatService.setDisappearing(uid(req), req.params.id, req.body.seconds))));

// ── link preview ──
// Cached in memory: a URL pasted into a busy group would otherwise be fetched once per reader.
const previewCache = new Map<string, { at: number; value: unknown }>();
const PREVIEW_TTL_MS = 6 * 60 * 60 * 1000;
chatRouter.get('/chat/link-preview', asyncHandler(async (req, res) => {
  const url = String(req.query.url ?? '');
  if (!url) { res.status(400).json({ error: 'url is required' }); return; }
  const hit = previewCache.get(url);
  if (hit && Date.now() - hit.at < PREVIEW_TTL_MS) { res.json(hit.value); return; }
  const value = await fetchLinkPreview(url);
  if (previewCache.size > 500) previewCache.clear(); // crude bound; previews are cheap to refetch
  previewCache.set(url, { at: Date.now(), value });
  res.json(value);
}));

// ── privacy + blocking ──
chatRouter.get('/chat/privacy', asyncHandler(async (req, res) => res.json(await chatService.getPrivacy(uid(req)))));
chatRouter.patch('/chat/privacy', validate(z.object({
  readReceipts: z.boolean().optional(),
  lastSeen: z.enum(['everyone', 'nobody']).optional(),
})), asyncHandler(async (req, res) => res.json(await chatService.updatePrivacy(uid(req), req.body))));
chatRouter.post('/chat/block/:userId', asyncHandler(async (req, res) => res.json(await chatService.setBlocked(uid(req), req.params.userId, true))));
chatRouter.delete('/chat/block/:userId', asyncHandler(async (req, res) => res.json(await chatService.setBlocked(uid(req), req.params.userId, false))));
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
chatRouter.get('/conversations/:id/messages', asyncHandler(async (req, res) => res.json(await chatService.getMessages(uid(req), req.params.id, { before: req.query.before as string | undefined, after: req.query.after as string | undefined, limit: req.query.limit ? Number(req.query.limit) : undefined }))));
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
chatRouter.get('/messages/:id/receipts', asyncHandler(async (req, res) => res.json(await chatService.receipts(uid(req), req.params.id))));
chatRouter.post('/messages/read', validate(z.object({ conversationId: z.string().min(1) })), asyncHandler(async (req, res) => res.json(await chatService.markRead(uid(req), req.body.conversationId))));
chatRouter.post('/messages/forward', validate(z.object({ messageId: z.string().min(1), conversationIds: z.array(z.string()).min(1) })), asyncHandler(async (req, res) => res.json(await chatService.forward(uid(req), req.body.messageId, req.body.conversationIds))));
chatRouter.get('/messages/starred', asyncHandler(async (req, res) => res.json(await chatService.starred(uid(req)))));
chatRouter.get('/messages/search', asyncHandler(async (req, res) => res.json(await chatService.search(uid(req), (req.query.q as string) ?? '', {
  senderId: req.query.senderId as string | undefined,
  conversationId: req.query.conversationId as string | undefined,
  before: req.query.before as string | undefined,
}))));

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

// ── status (24-hour stories) ──
chatRouter.get('/status', asyncHandler(async (req, res) => res.json(await statusService.feed(uid(req)))));
chatRouter.post('/status', validate(z.object({
  type: z.enum(['image', 'video', 'text']),
  caption: z.string().max(700).optional(),
  attachment: attachmentSchema.optional(),
  backgroundColor: z.string().max(20).optional(),
})), asyncHandler(async (req, res) => res.status(201).json(await statusService.post(uid(req), req.body))));
chatRouter.post('/status/:id/view', asyncHandler(async (req, res) => res.json(await statusService.markViewed(uid(req), req.params.id))));
chatRouter.delete('/status/:id', asyncHandler(async (req, res) => res.json(await statusService.remove(uid(req), req.params.id))));
