import { BadRequest } from '../common/errors';
import { msOAuth } from './oauth';
import { SIG_LOGO_CID, SIG_LOGO_CONTENT_TYPE, SIG_LOGO_B64 } from './sigLogo';

// Microsoft Graph proxy. Maps Graph messages → the app's Email shape (see Frontend src/types/email).
export type EmailFolder = 'inbox' | 'sent' | 'drafts' | 'deleted' | 'spam';
export interface EmailAddress { name: string; email: string }
export interface EmailDTO {
  id: string;
  folder: EmailFolder;
  from: EmailAddress;
  to: EmailAddress[];
  cc?: EmailAddress[];
  subject: string;
  preview: string;
  body: string;
  bodyType?: 'html' | 'text';
  ts: number;
  read: boolean;
  starred?: boolean;
  hasAttachments?: boolean;
  color: string;
}
export interface OutAttachment { name: string; contentType: string; contentBytes: string }
export interface AttachmentMeta { id: string; name: string; contentType: string; size: number }
export interface EmailDraftInput { to: string; cc?: string; bcc?: string; subject: string; body: string; bodyType?: 'html' | 'text'; attachments?: OutAttachment[] }

const GRAPH = 'https://graph.microsoft.com/v1.0';
const FOLDER_WK: Record<EmailFolder, string> = { inbox: 'inbox', sent: 'sentitems', drafts: 'drafts', deleted: 'deleteditems', spam: 'junkemail' };
const ORDER: Record<EmailFolder, string> = { inbox: 'receivedDateTime desc', deleted: 'receivedDateTime desc', sent: 'sentDateTime desc', drafts: 'lastModifiedDateTime desc', spam: 'receivedDateTime desc' };
const SELECT = 'id,subject,bodyPreview,from,toRecipients,ccRecipients,receivedDateTime,sentDateTime,lastModifiedDateTime,isRead,flag,hasAttachments';
const PALETTE = ['#6C5CE7', '#0984E3', '#00B894', '#E17055', '#D63031', '#2D3436'];
const colorFor = (s: string): string => PALETTE[[...s].reduce((n, c) => n + c.charCodeAt(0), 0) % PALETTE.length];

/* eslint-disable @typescript-eslint/no-explicit-any */
const addr = (a: any): EmailAddress => ({ name: a?.emailAddress?.name ?? '', email: a?.emailAddress?.address ?? '' });
const parseAddrs = (s?: string): any[] =>
  (s ?? '').split(/[,;]+/).map((x) => x.trim()).filter(Boolean).map((a) => ({ emailAddress: { address: a } }));

function mapMessage(m: any, folder: EmailFolder): EmailDTO {
  return {
    id: m.id,
    folder,
    from: addr(m.from),
    to: (m.toRecipients ?? []).map(addr),
    cc: (m.ccRecipients ?? []).map(addr),
    subject: m.subject || '(no subject)',
    preview: m.bodyPreview ?? '',
    body: m.body?.content ?? m.bodyPreview ?? '',
    bodyType: m.body?.contentType === 'html' ? 'html' : 'text',
    ts: new Date(m.receivedDateTime || m.sentDateTime || m.lastModifiedDateTime || Date.now()).getTime(),
    read: !!m.isRead,
    starred: m.flag?.flagStatus === 'flagged',
    hasAttachments: !!m.hasAttachments,
    color: colorFor(m.from?.emailAddress?.address || m.subject || 'mail'),
  };
}

// Message envelope (subject/body/recipients). Attachments are added to the created draft separately
// (see addAttachments) so total size isn't capped by Graph's ~4 MB single-request message limit.
function buildMessage(d: EmailDraftInput): Record<string, unknown> {
  return {
    subject: d.subject || '',
    body: { contentType: d.bodyType === 'html' ? 'HTML' : 'Text', content: d.body || '' },
    toRecipients: parseAddrs(d.to),
    ...(d.cc ? { ccRecipients: parseAddrs(d.cc) } : {}),
    ...(d.bcc ? { bccRecipients: parseAddrs(d.bcc) } : {}),
  };
}

// Bytes represented by a base64 string (sans padding) — decides inline-vs-upload-session per file.
const base64Size = (b64: string): number => Math.floor((b64.length * 3) / 4) - (b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0);
const ATTACH_INLINE_LIMIT = 3 * 1024 * 1024; // ≤3 MB → single POST; larger → chunked upload session
const UPLOAD_CHUNK = 5 * 327680; // 1.6 MB — Graph requires chunks be a multiple of 320 KiB (except the last)

async function graphFetch(userId: string, path: string, init: RequestInit = {}): Promise<any> {
  const token = await msOAuth.getValidAccessToken(userId);
  const resp = await fetch(`${GRAPH}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });
  if (resp.status === 204) return null;
  const text = await resp.text();
  const json = text ? JSON.parse(text) : null;
  if (!resp.ok) throw BadRequest(`Graph error: ${json?.error?.message ?? resp.statusText}`);
  return json;
}

// Attach one file to an existing draft message. Small files go in a single request; large files use
// a Graph upload session (pre-authorized upload URL, chunked PUT — no auth header on the chunk PUTs).
async function addAttachment(userId: string, messageId: string, a: OutAttachment): Promise<void> {
  const size = base64Size(a.contentBytes);
  if (size <= ATTACH_INLINE_LIMIT) {
    await graphFetch(userId, `/me/messages/${messageId}/attachments`, {
      method: 'POST',
      body: JSON.stringify({ '@odata.type': '#microsoft.graph.fileAttachment', name: a.name, contentType: a.contentType, contentBytes: a.contentBytes }),
    });
    return;
  }
  const session = await graphFetch(userId, `/me/messages/${messageId}/attachments/createUploadSession`, {
    method: 'POST',
    body: JSON.stringify({ AttachmentItem: { attachmentType: 'file', name: a.name, size, contentType: a.contentType } }),
  });
  const uploadUrl: string = session?.uploadUrl;
  if (!uploadUrl) throw BadRequest('Could not start attachment upload');
  const buf = Buffer.from(a.contentBytes, 'base64');
  for (let start = 0; start < buf.length; start += UPLOAD_CHUNK) {
    const end = Math.min(start + UPLOAD_CHUNK, buf.length);
    const chunk = buf.subarray(start, end);
    const resp = await fetch(uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Length': String(chunk.length), 'Content-Range': `bytes ${start}-${end - 1}/${buf.length}` },
      body: chunk,
    });
    if (!resp.ok && resp.status !== 200 && resp.status !== 201 && resp.status !== 202) {
      throw BadRequest(`Attachment upload failed (${resp.status})`);
    }
  }
}

async function addAttachments(userId: string, messageId: string, atts?: OutAttachment[]): Promise<void> {
  for (const a of atts ?? []) await addAttachment(userId, messageId, a);
}

// The app's signature HTML references the Travkings logo as `cid:tk-sig-logo`. Attach the logo
// bytes INLINE (isInline + contentId) whenever an outgoing body carries that reference, so the
// signature banner renders in every recipient's client — same mechanism Outlook itself uses.
async function attachSignatureLogo(userId: string, messageId: string, body?: string): Promise<void> {
  if (!body?.includes(`cid:${SIG_LOGO_CID}`)) return;
  await graphFetch(userId, `/me/messages/${messageId}/attachments`, {
    method: 'POST',
    body: JSON.stringify({
      '@odata.type': '#microsoft.graph.fileAttachment',
      name: 'travkings-logo.png',
      contentType: SIG_LOGO_CONTENT_TYPE,
      contentBytes: SIG_LOGO_B64,
      isInline: true,
      contentId: SIG_LOGO_CID,
    }),
  });
}

// Map a user's well-known folder ids → our EmailFolder (for stamping mailbox-wide search results).
// Cached per user — well-known folder ids are stable for the life of the mailbox.
const wkFolderCache = new Map<string, Record<string, EmailFolder>>();
async function folderIdMap(userId: string): Promise<Record<string, EmailFolder>> {
  const cached = wkFolderCache.get(userId);
  if (cached) return cached;
  const folders = Object.keys(FOLDER_WK) as EmailFolder[];
  const entries = await Promise.all(
    folders.map(async (f) => {
      try {
        const j = await graphFetch(userId, `/me/mailFolders/${FOLDER_WK[f]}?$select=id`);
        return [j?.id as string | undefined, f] as const;
      } catch {
        return [undefined, f] as const;
      }
    }),
  );
  const map: Record<string, EmailFolder> = {};
  for (const [id, f] of entries) if (id) map[id] = f;
  wkFolderCache.set(userId, map);
  return map;
}

// Used during connect, with a freshly-exchanged token (before the account is stored).
export async function fetchMe(accessToken: string): Promise<{ id: string; email: string; name: string }> {
  const resp = await fetch(`${GRAPH}/me?$select=id,mail,userPrincipalName,displayName`, { headers: { Authorization: `Bearer ${accessToken}` } });
  const json = (await resp.json()) as any;
  if (!resp.ok) throw BadRequest(`Graph /me failed: ${json?.error?.message ?? resp.statusText}`);
  return { id: json.id, email: json.mail || json.userPrincipalName, name: json.displayName };
}

export const graph = {
  async listMessages(userId: string, folder: EmailFolder, skip = 0): Promise<EmailDTO[]> {
    const wk = FOLDER_WK[folder];
    if (!wk) throw BadRequest('Unknown folder');
    // Paged: $skip lets the client load older messages on scroll (infinite scroll). PAGE must match
    // the client's page size so "more available?" (returned === PAGE) is correct.
    const PAGE = 40;
    const q = `?$top=${PAGE}&$skip=${Math.max(0, skip)}&$select=${SELECT}&$orderby=${encodeURIComponent(ORDER[folder])}`;
    const json = await graphFetch(userId, `/me/mailFolders/${wk}/messages${q}`);
    return (json?.value ?? []).map((m: any) => mapMessage(m, folder));
  },
  async getMessage(userId: string, id: string, folder: EmailFolder = 'inbox'): Promise<EmailDTO> {
    const json = await graphFetch(userId, `/me/messages/${id}?$select=${SELECT},body`);
    const dto = mapMessage(json, folder);
    // Outlook signatures/pasted images arrive as INLINE attachments referenced by `src="cid:…"`.
    // A WebView can't resolve cid: URIs (they render as broken images), so swap each reference
    // for a data: URI built from the attachment bytes. Best-effort: on any failure the body goes
    // out unchanged rather than failing the whole message fetch.
    if (dto.bodyType === 'html' && dto.body.includes('cid:')) {
      try {
        const atts = await graphFetch(userId, `/me/messages/${id}/attachments`);
        for (const a of atts?.value ?? []) {
          if (!a?.contentId || !a?.contentBytes) continue;
          dto.body = dto.body.split(`cid:${a.contentId}`).join(`data:${a.contentType ?? 'image/png'};base64,${a.contentBytes}`);
        }
      } catch { /* leave cid: refs — the text still renders */ }
    }
    return dto;
  },
  async sendMail(userId: string, draft: EmailDraftInput, id?: string): Promise<EmailDTO> {
    if (id) {
      // Resume an existing draft: update it, attach files, then send (Graph moves it to Sent and
      // removes it from Drafts — no stray draft copy left behind).
      await graphFetch(userId, `/me/messages/${id}`, { method: 'PATCH', body: JSON.stringify(buildMessage(draft)) });
      await addAttachments(userId, id, draft.attachments);
      await attachSignatureLogo(userId, id, draft.body);
      await graphFetch(userId, `/me/messages/${id}/send`, { method: 'POST' });
      return mapMessage({ id, subject: draft.subject, toRecipients: parseAddrs(draft.to), sentDateTime: new Date().toISOString(), isRead: true }, 'sent');
    }
    // create draft → attach files → send: gives a real id and lands in Sent Items.
    const created = await graphFetch(userId, '/me/messages', { method: 'POST', body: JSON.stringify(buildMessage(draft)) });
    await addAttachments(userId, created.id, draft.attachments);
    await attachSignatureLogo(userId, created.id, draft.body);
    await graphFetch(userId, `/me/messages/${created.id}/send`, { method: 'POST' });
    return mapMessage({ ...created, sentDateTime: new Date().toISOString() }, 'sent');
  },
  async saveDraft(userId: string, draft: EmailDraftInput, id?: string): Promise<EmailDTO> {
    if (id) {
      await graphFetch(userId, `/me/messages/${id}`, { method: 'PATCH', body: JSON.stringify(buildMessage(draft)) });
      await addAttachments(userId, id, draft.attachments);
      const got = await graphFetch(userId, `/me/messages/${id}?$select=${SELECT},body`);
      return mapMessage(got, 'drafts');
    }
    const created = await graphFetch(userId, '/me/messages', { method: 'POST', body: JSON.stringify(buildMessage(draft)) });
    await addAttachments(userId, created.id, draft.attachments);
    // Re-fetch so the returned DTO reflects the attachments we just added (hasAttachments + body).
    const got = await graphFetch(userId, `/me/messages/${created.id}?$select=${SELECT},body`);
    return mapMessage(got, 'drafts');
  },
  // Graph re-keys a message when it moves folders — the response carries the moved copy's NEW id.
  // Return it so clients can re-key; acting on the old id afterwards (e.g. delete) 404s.
  async move(userId: string, id: string, folder: EmailFolder): Promise<{ id: string }> {
    const j = await graphFetch(userId, `/me/messages/${id}/move`, { method: 'POST', body: JSON.stringify({ destinationId: FOLDER_WK[folder] }) });
    return { id: j?.id ?? id };
  },
  // ── custom (smart) folders ──
  // Create a real Outlook mail folder; returns its id (used as the smart folder's destination).
  async createFolder(userId: string, displayName: string): Promise<{ id: string; displayName: string }> {
    const j = await graphFetch(userId, '/me/mailFolders', { method: 'POST', body: JSON.stringify({ displayName }) });
    return { id: j.id, displayName: j.displayName };
  },
  // List messages in an arbitrary folder by its Graph id (smart folders). Folder stamped 'inbox' for
  // the DTO — message actions (read/star/move/delete) are addressed by message id, folder-agnostic.
  async listFolderMessages(userId: string, folderId: string, skip = 0): Promise<EmailDTO[]> {
    const PAGE = 40;
    const q = `?$top=${PAGE}&$skip=${Math.max(0, skip)}&$select=${SELECT}&$orderby=${encodeURIComponent('receivedDateTime desc')}`;
    const json = await graphFetch(userId, `/me/mailFolders/${folderId}/messages${q}`);
    return (json?.value ?? []).map((m: any) => mapMessage(m, 'inbox'));
  },
  async moveToFolderId(userId: string, id: string, folderId: string): Promise<void> {
    await graphFetch(userId, `/me/messages/${id}/move`, { method: 'POST', body: JSON.stringify({ destinationId: folderId }) });
  },
  // One-time: move existing inbox mail whose sender matches into the folder. Capped to avoid runaway.
  async backfillIntoFolder(userId: string, folderId: string, matches: string[]): Promise<number> {
    const low = matches.map((m) => m.toLowerCase().trim()).filter(Boolean);
    if (!low.length) return 0;
    let moved = 0;
    for (let skip = 0; skip < 500; skip += 50) {
      const json = await graphFetch(userId, `/me/mailFolders/inbox/messages?$top=50&$skip=${skip}&$select=id,from`);
      const msgs: any[] = json?.value ?? [];
      if (!msgs.length) break;
      for (const m of msgs) {
        const fromEmail = (m.from?.emailAddress?.address ?? '').toLowerCase();
        if (fromEmail && low.some((x) => fromEmail.includes(x))) {
          await this.moveToFolderId(userId, m.id, folderId).catch(() => undefined);
          moved++;
        }
      }
      if (msgs.length < 50) break;
    }
    return moved;
  },
  async setRead(userId: string, id: string, read: boolean): Promise<void> {
    await graphFetch(userId, `/me/messages/${id}`, { method: 'PATCH', body: JSON.stringify({ isRead: read }) });
  },
  async setFlag(userId: string, id: string, starred: boolean): Promise<void> {
    await graphFetch(userId, `/me/messages/${id}`, { method: 'PATCH', body: JSON.stringify({ flag: { flagStatus: starred ? 'flagged' : 'notFlagged' } }) });
  },
  async deleteMessage(userId: string, id: string): Promise<void> {
    await graphFetch(userId, `/me/messages/${id}`, { method: 'DELETE' });
  },
  // Server-side search across the WHOLE mailbox (all folders) via Graph $search on /me/messages —
  // subject/body/from/etc., not just a loaded page. Each result is stamped with its real folder
  // (resolved from parentFolderId) so the detail view shows the right actions. $search returns by
  // relevance and cannot be combined with $orderby.
  async search(userId: string, query: string): Promise<EmailDTO[]> {
    const q = query.replace(/["*]/g, '').trim();
    if (!q) return [];
    const idMap = await folderIdMap(userId);
    const page = async (url: string): Promise<any[]> => (await graphFetch(userId, url))?.value ?? [];
    const sel = `$select=${SELECT},parentFolderId&$top=50`;
    let results: any[] = [];
    // 1. Plain full-text $search — whole-word matches across subject/body/participants, by relevance.
    try {
      results = await page(`/me/messages?$search=${encodeURIComponent(`"${q}"`)}&${sel}`);
    } catch (e) { console.warn('[email.search] $search failed:', (e as Error).message); }
    // 2. KQL prefix fallback — a partial contact name ("suj" for Sujeet) isn't a whole word, so try
    //    prefix wildcards on participants (from/to/cc — mail SENT TO the person counts) + subject.
    if (!results.length) {
      try {
        results = await page(`/me/messages?$search=${encodeURIComponent(`"participants:${q}* OR subject:${q}*"`)}&${sel}`);
      } catch (e) { console.warn('[email.search] KQL prefix failed:', (e as Error).message); }
    }
    // 3. $filter last resort (works even where $search is disabled): sender name/address prefix.
    //    (toRecipients can't be $filtered on messages; no $orderby with these filters → sort here.)
    if (!results.length) {
      const esc = q.replace(/'/g, "''");
      const filter = `startswith(from/emailAddress/name,'${esc}') or startswith(from/emailAddress/address,'${esc}')`;
      try {
        results = (await page(`/me/messages?$filter=${encodeURIComponent(filter)}&${sel}`))
          .sort((a: any, b: any) => String(b.receivedDateTime ?? '').localeCompare(String(a.receivedDateTime ?? '')));
      } catch (e) { console.warn('[email.search] $filter fallback failed:', (e as Error).message); }
    }
    return results.map((m: any) => mapMessage(m, idMap[m.parentFolderId] ?? 'inbox'));
  },
  // Mark every unread message in a folder as read (Graph has no bulk endpoint, so we page through the
  // unread ones and PATCH them). Capped to avoid a runaway loop on huge mailboxes.
  async markFolderRead(userId: string, folder: EmailFolder): Promise<number> {
    const wk = FOLDER_WK[folder];
    if (!wk) throw BadRequest('Unknown folder');
    let total = 0;
    for (let i = 0; i < 30; i++) {
      const json = await graphFetch(userId, `/me/mailFolders/${wk}/messages?$filter=${encodeURIComponent('isRead eq false')}&$select=id&$top=20`);
      const ids: string[] = (json?.value ?? []).map((m: any) => m.id);
      if (!ids.length) break;
      await Promise.all(ids.map((id) => this.setRead(userId, id, true)));
      total += ids.length;
    }
    return total;
  },
  // Real unread count for the Inbox (Graph's own counter — exact, not limited to a loaded page).
  async inboxUnread(userId: string): Promise<number> {
    const json = await graphFetch(userId, '/me/mailFolders/inbox?$select=unreadItemCount');
    return typeof json?.unreadItemCount === 'number' ? json.unreadItemCount : 0;
  },
  // New inbox messages received after `sinceIso` (for the new-mail poller + smart-folder routing).
  async newSince(userId: string, sinceIso: string): Promise<{ id: string; subject: string; from: string; fromEmail: string }[]> {
    const q = `?$filter=${encodeURIComponent(`receivedDateTime gt ${sinceIso}`)}&$select=id,subject,from,receivedDateTime&$top=25&$orderby=receivedDateTime desc`;
    const json = await graphFetch(userId, `/me/mailFolders/inbox/messages${q}`);
    return (json?.value ?? []).map((m: any) => ({
      id: m.id,
      subject: m.subject || '(no subject)',
      from: m.from?.emailAddress?.name || m.from?.emailAddress?.address || 'Someone',
      fromEmail: m.from?.emailAddress?.address ?? '',
    }));
  },
  async listAttachments(userId: string, id: string): Promise<AttachmentMeta[]> {
    // isInline must be in the $select or the filter below sees `undefined` and keeps signature
    // images (they belong in the rendered body, not the attachment chips).
    const json = await graphFetch(userId, `/me/messages/${id}/attachments?$select=id,name,contentType,size,isInline`);
    return (json?.value ?? [])
      .filter((a: any) => !a.isInline)
      .map((a: any) => ({ id: a.id, name: a.name ?? 'attachment', contentType: a.contentType ?? 'application/octet-stream', size: a.size ?? 0 }));
  },
  // Returns the file content as base64 (Graph fileAttachment.contentBytes).
  async getAttachment(userId: string, id: string, attId: string): Promise<{ name: string; contentType: string; contentBytes: string }> {
    const a = await graphFetch(userId, `/me/messages/${id}/attachments/${attId}`);
    return { name: a.name ?? 'attachment', contentType: a.contentType ?? 'application/octet-stream', contentBytes: a.contentBytes ?? '' };
  },
};
