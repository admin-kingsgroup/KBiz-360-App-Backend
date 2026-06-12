import { BadRequest } from '../common/errors';
import { msOAuth } from './oauth';

// Microsoft Graph proxy. Maps Graph messages → the app's Email shape (see Frontend src/types/email).
export type EmailFolder = 'inbox' | 'sent' | 'drafts' | 'deleted';
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
export interface EmailDraftInput { to: string; cc?: string; bcc?: string; subject: string; body: string; attachments?: OutAttachment[] }

const GRAPH = 'https://graph.microsoft.com/v1.0';
const FOLDER_WK: Record<EmailFolder, string> = { inbox: 'inbox', sent: 'sentitems', drafts: 'drafts', deleted: 'deleteditems' };
const ORDER: Record<EmailFolder, string> = { inbox: 'receivedDateTime desc', deleted: 'receivedDateTime desc', sent: 'sentDateTime desc', drafts: 'lastModifiedDateTime desc' };
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

function buildMessage(d: EmailDraftInput): Record<string, unknown> {
  return {
    subject: d.subject || '',
    body: { contentType: 'Text', content: d.body || '' },
    toRecipients: parseAddrs(d.to),
    ...(d.cc ? { ccRecipients: parseAddrs(d.cc) } : {}),
    ...(d.bcc ? { bccRecipients: parseAddrs(d.bcc) } : {}),
    ...(d.attachments?.length
      ? { attachments: d.attachments.map((a) => ({ '@odata.type': '#microsoft.graph.fileAttachment', name: a.name, contentType: a.contentType, contentBytes: a.contentBytes })) }
      : {}),
  };
}

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

// Used during connect, with a freshly-exchanged token (before the account is stored).
export async function fetchMe(accessToken: string): Promise<{ id: string; email: string; name: string }> {
  const resp = await fetch(`${GRAPH}/me?$select=id,mail,userPrincipalName,displayName`, { headers: { Authorization: `Bearer ${accessToken}` } });
  const json = (await resp.json()) as any;
  if (!resp.ok) throw BadRequest(`Graph /me failed: ${json?.error?.message ?? resp.statusText}`);
  return { id: json.id, email: json.mail || json.userPrincipalName, name: json.displayName };
}

export const graph = {
  async listMessages(userId: string, folder: EmailFolder): Promise<EmailDTO[]> {
    const wk = FOLDER_WK[folder];
    if (!wk) throw BadRequest('Unknown folder');
    const q = `?$top=40&$select=${SELECT}&$orderby=${encodeURIComponent(ORDER[folder])}`;
    const json = await graphFetch(userId, `/me/mailFolders/${wk}/messages${q}`);
    return (json?.value ?? []).map((m: any) => mapMessage(m, folder));
  },
  async getMessage(userId: string, id: string, folder: EmailFolder = 'inbox'): Promise<EmailDTO> {
    const json = await graphFetch(userId, `/me/messages/${id}?$select=${SELECT},body`);
    return mapMessage(json, folder);
  },
  async sendMail(userId: string, draft: EmailDraftInput): Promise<EmailDTO> {
    // create draft → send: gives a real id and lands in Sent Items.
    const created = await graphFetch(userId, '/me/messages', { method: 'POST', body: JSON.stringify(buildMessage(draft)) });
    await graphFetch(userId, `/me/messages/${created.id}/send`, { method: 'POST' });
    return mapMessage({ ...created, sentDateTime: new Date().toISOString() }, 'sent');
  },
  async saveDraft(userId: string, draft: EmailDraftInput, id?: string): Promise<EmailDTO> {
    if (id) {
      await graphFetch(userId, `/me/messages/${id}`, { method: 'PATCH', body: JSON.stringify(buildMessage(draft)) });
      const got = await graphFetch(userId, `/me/messages/${id}?$select=${SELECT},body`);
      return mapMessage(got, 'drafts');
    }
    const created = await graphFetch(userId, '/me/messages', { method: 'POST', body: JSON.stringify(buildMessage(draft)) });
    return mapMessage(created, 'drafts');
  },
  async move(userId: string, id: string, folder: EmailFolder): Promise<void> {
    await graphFetch(userId, `/me/messages/${id}/move`, { method: 'POST', body: JSON.stringify({ destinationId: FOLDER_WK[folder] }) });
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
  // New inbox messages received after `sinceIso` (for the new-mail poller).
  async newSince(userId: string, sinceIso: string): Promise<{ id: string; subject: string; from: string }[]> {
    const q = `?$filter=${encodeURIComponent(`receivedDateTime gt ${sinceIso}`)}&$select=id,subject,from,receivedDateTime&$top=10&$orderby=receivedDateTime desc`;
    const json = await graphFetch(userId, `/me/mailFolders/inbox/messages${q}`);
    return (json?.value ?? []).map((m: any) => ({ id: m.id, subject: m.subject || '(no subject)', from: m.from?.emailAddress?.name || m.from?.emailAddress?.address || 'Someone' }));
  },
  async listAttachments(userId: string, id: string): Promise<AttachmentMeta[]> {
    const json = await graphFetch(userId, `/me/messages/${id}/attachments?$select=id,name,contentType,size`);
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
