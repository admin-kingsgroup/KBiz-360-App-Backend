import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../common/asyncHandler';
import { validate } from '../common/validate';
import { Unauthorized, BadRequest } from '../common/errors';
import { requireAuth } from '../mongo/middleware';
import { msOAuth } from './oauth';
import { fetchMe, graph, type EmailFolder } from './graph';
import { emailAccountRepo } from './account.model';
import { smartFolderRepo } from './smartFolder.model';

// NOTE: the signed image proxy (GET /api/email/img, imageProxy.ts) is mounted in mongo/app.ts
// BEFORE the /api-wide requireAuth routers — <img> tags cannot attach the JWT, and a route here
// would sit behind chatRouter's router-wide auth and 401.
export const emailRouter: Router = Router();
emailRouter.use(requireAuth);
const uid = (req: { auth?: { userId: string } }): string => { if (!req.auth) throw Unauthorized(); return req.auth.userId; };
const FOLDERS = new Set<EmailFolder>(['inbox', 'sent', 'drafts', 'deleted', 'spam']);
const asFolder = (s: string): EmailFolder => { if (!FOLDERS.has(s as EmailFolder)) throw BadRequest('Unknown folder'); return s as EmailFolder; };

const attachmentSchema = z.object({ name: z.string(), contentType: z.string(), contentBytes: z.string() });
const draftSchema = z.object({ to: z.string().default(''), cc: z.string().optional(), bcc: z.string().optional(), subject: z.string().default(''), body: z.string().default(''), bodyType: z.enum(['html', 'text']).optional(), id: z.string().optional(), attachments: z.array(attachmentSchema).optional() });

// ── account / OAuth ──
// POST /api/email/connect — the app sends the PKCE auth code; we exchange + store tokens server-side.
emailRouter.post('/email/connect', validate(z.object({ code: z.string().min(1), codeVerifier: z.string().min(1), redirectUri: z.string().min(1) })), asyncHandler(async (req, res) => {
  const { code, codeVerifier, redirectUri } = req.body as { code: string; codeVerifier: string; redirectUri: string };
  // eslint-disable-next-line no-console
  console.log(`[email] connect attempt user=${uid(req)} redirectUri=${redirectUri} codeLen=${code?.length} verifierLen=${codeVerifier?.length}`);
  const tokens = await msOAuth.exchangeCode(code, codeVerifier, redirectUri);
  const me = await fetchMe(tokens.access_token);
  await msOAuth.store(uid(req), me.email, me.id, tokens);
  // eslint-disable-next-line no-console
  console.log(`[email] connected user=${uid(req)} mailbox=${me.email}`);
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
// GET /api/email/search?q=... — server-side search across ALL folders (Graph $search on /me/messages).
emailRouter.get('/email/search', asyncHandler(async (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q : '';
  res.json(await graph.search(uid(req), q));
}));
// Per-folder unread counts — { inbox, sent, drafts, deleted, spam }. `inbox` drives the Email tab
// badge (older clients read only that key); the rest badge the folder list. Zeros if not connected.
emailRouter.get('/email/unread', asyncHandler(async (req, res) => {
  const acct = await emailAccountRepo.find(uid(req));
  if (!acct) { res.json({ inbox: 0, sent: 0, drafts: 0, deleted: 0, spam: 0 }); return; }
  res.json(await graph.folderUnread(uid(req)));
}));
emailRouter.get('/email/messages/:id/attachments', asyncHandler(async (req, res) => res.json(await graph.listAttachments(uid(req), req.params.id))));
emailRouter.get('/email/messages/:id/attachments/:attId', asyncHandler(async (req, res) => res.json(await graph.getAttachment(uid(req), req.params.id, req.params.attId))));
emailRouter.get('/email/messages/:id', asyncHandler(async (req, res) => res.json(await graph.getMessage(uid(req), req.params.id, (req.query.folder as EmailFolder) ?? 'inbox'))));
emailRouter.post('/email/send', validate(draftSchema), asyncHandler(async (req, res) => res.status(201).json(await graph.sendMail(uid(req), req.body, req.body.id))));
emailRouter.post('/email/drafts', validate(draftSchema), asyncHandler(async (req, res) => res.status(201).json(await graph.saveDraft(uid(req), req.body, req.body.id))));
// Returns { id: newId } — Graph re-keys a message on move; the client must adopt the new id.
emailRouter.post('/email/messages/:id/move', validate(z.object({ folder: z.string() })), asyncHandler(async (req, res) => { res.json(await graph.move(uid(req), req.params.id, asFolder(req.body.folder))); }));
// Move into an arbitrary Outlook folder by its Graph id (file a message into a user folder).
emailRouter.post('/email/messages/:id/move-to', validate(z.object({ folderId: z.string().min(1) })), asyncHandler(async (req, res) => {
  res.json(await graph.moveToFolderId(uid(req), req.params.id, req.body.folderId));
}));
emailRouter.post('/email/messages/:id/read', validate(z.object({ read: z.boolean() })), asyncHandler(async (req, res) => { await graph.setRead(uid(req), req.params.id, req.body.read); res.status(204).send(); }));
// POST /api/email/mark-all-read — mark every unread message in a folder as read.
emailRouter.post('/email/mark-all-read', validate(z.object({ folder: z.string() })), asyncHandler(async (req, res) => {
  res.json({ count: await graph.markFolderRead(uid(req), asFolder(req.body.folder)) });
}));
emailRouter.post('/email/messages/:id/flag', validate(z.object({ starred: z.boolean() })), asyncHandler(async (req, res) => { await graph.setFlag(uid(req), req.params.id, req.body.starred); res.status(204).send(); }));
emailRouter.delete('/email/messages/:id', asyncHandler(async (req, res) => { await graph.deleteMessage(uid(req), req.params.id); res.status(204).send(); }));

// ── smart folders (auto-categorize incoming mail) — BEFORE the /:folder catch-all ──
const sfDTO = (d: { _id: unknown; name: string; graphFolderId: string; from: string[] }) => ({ id: String(d._id), name: d.name, graphFolderId: d.graphFolderId, from: d.from });
// GET /api/email/folders — the user's smart folders.
emailRouter.get('/email/folders', asyncHandler(async (req, res) => res.json((await smartFolderRepo.listForUser(uid(req))).map(sfDTO))));
// POST /api/email/folders { name, from: string[], backfill? } — create the Outlook folder + routing rule.
emailRouter.post('/email/folders', validate(z.object({ name: z.string().min(1).max(60), from: z.array(z.string().min(1)).min(1), backfill: z.boolean().optional() })),
  asyncHandler(async (req, res) => {
    const userId = uid(req);
    const { name, from, backfill } = req.body as { name: string; from: string[]; backfill?: boolean };
    const matches = [...new Set(from.map((s) => s.trim().toLowerCase()).filter(Boolean))];
    const folder = await graph.createFolder(userId, name.trim());
    // Native Outlook rule so the MAILBOX files matching mail the instant it arrives (works even
    // when this backend is down). Best-effort: without it, the 60s poll still routes new mail.
    let graphRuleId: string | null = null;
    if (matches.length) {
      try { graphRuleId = (await graph.createInboxRule(userId, `KB360 · ${name.trim()}`, matches, folder.id)).id; } catch { /* poll fallback */ }
    }
    const sf = await smartFolderRepo.create({ userId, name: name.trim(), graphFolderId: folder.id, from: matches, graphRuleId });
    if (backfill) { try { await graph.backfillIntoFolder(userId, folder.id, matches); } catch { /* best-effort */ } }
    res.status(201).json(sfDTO(sf));
  }));
// PATCH /api/email/folders/:id { name?, from?, backfill? } — edit a smart folder's name and/or
// sender matches. Renames the real Outlook folder and keeps its native inbox rule in lockstep
// (updated in place; recreated if it was deleted in Outlook). backfill re-files existing inbox
// mail that matches the NEW senders.
emailRouter.patch('/email/folders/:id',
  validate(z.object({ name: z.string().min(1).max(60).optional(), from: z.array(z.string().min(1)).min(1).optional(), backfill: z.boolean().optional() })),
  asyncHandler(async (req, res) => {
    const userId = uid(req);
    const sf = await smartFolderRepo.byId(userId, req.params.id);
    if (!sf) throw BadRequest('Folder not found');
    const { name, from, backfill } = req.body as { name?: string; from?: string[]; backfill?: boolean };
    const nextName = name?.trim() || sf.name;
    const matches = from ? [...new Set(from.map((s) => s.trim().toLowerCase()).filter(Boolean))] : sf.from;
    // Rename the real Outlook folder (best-effort — the app lists smart folders by the DB name).
    if (nextName !== sf.name) { try { await graph.renameFolder(userId, sf.graphFolderId, nextName); } catch { /* keep going */ } }
    let graphRuleId = sf.graphRuleId ?? null;
    if (matches.length) {
      if (graphRuleId) {
        try { await graph.updateInboxRule(userId, graphRuleId, `KB360 · ${nextName}`, matches); }
        catch { // rule vanished (e.g. deleted in Outlook) → recreate it
          try { graphRuleId = (await graph.createInboxRule(userId, `KB360 · ${nextName}`, matches, sf.graphFolderId)).id; } catch { graphRuleId = null; }
        }
      } else {
        try { graphRuleId = (await graph.createInboxRule(userId, `KB360 · ${nextName}`, matches, sf.graphFolderId)).id; } catch { /* poll fallback */ }
      }
    }
    const updated = await smartFolderRepo.update(userId, req.params.id, { name: nextName, from: matches, graphRuleId });
    if (backfill && from) { try { await graph.backfillIntoFolder(userId, sf.graphFolderId, matches); } catch { /* best-effort */ } }
    res.json(sfDTO(updated ?? { ...sf, name: nextName, from: matches }));
  }));
// DELETE /api/email/folders/:id — remove the smart folder AND its real Outlook folder (owner call,
// 07-31: deleting in-app deletes the folder). Graph moves the folder + its mail to Deleted Items,
// so nothing is lost irrecoverably. Folder deletion is best-effort: the rule always dies.
emailRouter.delete('/email/folders/:id', asyncHandler(async (req, res) => {
  const userId = uid(req);
  const sf = await smartFolderRepo.byId(userId, req.params.id);
  await smartFolderRepo.remove(userId, req.params.id);
  if (sf?.graphRuleId) { try { await graph.deleteInboxRule(userId, sf.graphRuleId); } catch { /* already gone */ } }
  if (sf?.graphFolderId) { try { await graph.deleteFolder(userId, sf.graphFolderId); } catch { /* already gone / Graph hiccup */ } }
  res.status(204).send();
}));
// DELETE /api/email/outlook-folders/:id — delete a real Outlook folder by Graph id (custom folders
// shown in the app's folder strip). Graph refuses well-known folders (Inbox/Sent/…) by itself.
emailRouter.delete('/email/outlook-folders/:id', asyncHandler(async (req, res) => {
  await graph.deleteFolder(uid(req), req.params.id);
  res.status(204).send();
}));
// GET /api/email/folders/:id/messages?skip=N — messages currently in this smart folder.
emailRouter.get('/email/folders/:id/messages', asyncHandler(async (req, res) => {
  const sf = await smartFolderRepo.byId(uid(req), req.params.id);
  if (!sf) throw BadRequest('Folder not found');
  res.json(await graph.listFolderMessages(uid(req), sf.graphFolderId, Number(req.query.skip) || 0));
}));

// ── real Outlook folders (created by the user in Outlook, or by smart folders) — BEFORE /:folder ──
// GET /api/email/outlook-folders — every user-created folder with live message/unread counts.
emailRouter.get('/email/outlook-folders', asyncHandler(async (req, res) => res.json(await graph.listMailFolders(uid(req)))));
// GET /api/email/outlook-folders/:id/messages?skip=N — messages in that folder (paged).
emailRouter.get('/email/outlook-folders/:id/messages', asyncHandler(async (req, res) => {
  res.json(await graph.listFolderMessages(uid(req), req.params.id, Number(req.query.skip) || 0));
}));

// GET /api/email/:folder?skip=N — inbox | sent | drafts | deleted (keep LAST). skip drives paging.
emailRouter.get('/email/:folder', asyncHandler(async (req, res) => {
  const skip = Number(req.query.skip) || 0;
  res.json(await graph.listMessages(uid(req), asFolder(req.params.folder), skip));
}));
