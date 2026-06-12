import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../common/asyncHandler';
import { validate } from '../common/validate';
import { Unauthorized, BadRequest } from '../common/errors';
import { requireAuth } from '../mongo/middleware';
import { msOAuth } from './oauth';
import { fetchMe, graph, type EmailFolder } from './graph';
import { emailAccountRepo } from './account.model';

export const emailRouter: Router = Router();
emailRouter.use(requireAuth);
const uid = (req: { auth?: { userId: string } }): string => { if (!req.auth) throw Unauthorized(); return req.auth.userId; };
const FOLDERS = new Set<EmailFolder>(['inbox', 'sent', 'drafts', 'deleted']);
const asFolder = (s: string): EmailFolder => { if (!FOLDERS.has(s as EmailFolder)) throw BadRequest('Unknown folder'); return s as EmailFolder; };

const attachmentSchema = z.object({ name: z.string(), contentType: z.string(), contentBytes: z.string() });
const draftSchema = z.object({ to: z.string().default(''), cc: z.string().optional(), bcc: z.string().optional(), subject: z.string().default(''), body: z.string().default(''), id: z.string().optional(), attachments: z.array(attachmentSchema).optional() });

// ── account / OAuth ──
// POST /api/email/connect — the app sends the PKCE auth code; we exchange + store tokens server-side.
emailRouter.post('/email/connect', validate(z.object({ code: z.string().min(1), codeVerifier: z.string().min(1), redirectUri: z.string().min(1) })), asyncHandler(async (req, res) => {
  const { code, codeVerifier, redirectUri } = req.body as { code: string; codeVerifier: string; redirectUri: string };
  const tokens = await msOAuth.exchangeCode(code, codeVerifier, redirectUri);
  const me = await fetchMe(tokens.access_token);
  await msOAuth.store(uid(req), me.email, me.id, tokens);
  res.json({ connected: true, email: me.email });
}));

// GET /api/email/status — is this user's mailbox connected?
emailRouter.get('/email/status', asyncHandler(async (req, res) => {
  const acct = await emailAccountRepo.find(uid(req));
  res.json({ connected: !!acct, email: acct?.email ?? null });
}));

// POST /api/email/disconnect
emailRouter.post('/email/disconnect', asyncHandler(async (req, res) => { await emailAccountRepo.remove(uid(req)); res.status(204).send(); }));

// ── messages (Graph proxy) — specific routes BEFORE the /:folder catch-all ──
emailRouter.get('/email/messages/:id/attachments', asyncHandler(async (req, res) => res.json(await graph.listAttachments(uid(req), req.params.id))));
emailRouter.get('/email/messages/:id/attachments/:attId', asyncHandler(async (req, res) => res.json(await graph.getAttachment(uid(req), req.params.id, req.params.attId))));
emailRouter.get('/email/messages/:id', asyncHandler(async (req, res) => res.json(await graph.getMessage(uid(req), req.params.id, (req.query.folder as EmailFolder) ?? 'inbox'))));
emailRouter.post('/email/send', validate(draftSchema), asyncHandler(async (req, res) => res.status(201).json(await graph.sendMail(uid(req), req.body))));
emailRouter.post('/email/drafts', validate(draftSchema), asyncHandler(async (req, res) => res.status(201).json(await graph.saveDraft(uid(req), req.body, req.body.id))));
emailRouter.post('/email/messages/:id/move', validate(z.object({ folder: z.string() })), asyncHandler(async (req, res) => { await graph.move(uid(req), req.params.id, asFolder(req.body.folder)); res.status(204).send(); }));
emailRouter.post('/email/messages/:id/read', validate(z.object({ read: z.boolean() })), asyncHandler(async (req, res) => { await graph.setRead(uid(req), req.params.id, req.body.read); res.status(204).send(); }));
emailRouter.post('/email/messages/:id/flag', validate(z.object({ starred: z.boolean() })), asyncHandler(async (req, res) => { await graph.setFlag(uid(req), req.params.id, req.body.starred); res.status(204).send(); }));
emailRouter.delete('/email/messages/:id', asyncHandler(async (req, res) => { await graph.deleteMessage(uid(req), req.params.id); res.status(204).send(); }));

// GET /api/email/:folder — inbox | sent | drafts | deleted (keep LAST).
emailRouter.get('/email/:folder', asyncHandler(async (req, res) => res.json(await graph.listMessages(uid(req), asFolder(req.params.folder)))));
