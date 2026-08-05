import { Types } from 'mongoose';
import { Forbidden, NotFound, BadRequest } from '../../common/errors';
import { crmRepo } from '../crm.repo';
import { userAvatars } from '../userAvatars';
import { StatusModel, type Attachment, type StatusDoc } from './chat.models';
import { chatSettingsRepo, conversationRepo } from './chat.repository';
import { emitToUsers } from './chat.events';

// Status — WhatsApp's 24-hour stories, scoped to colleagues instead of a phone book. The audience is
// everyone the poster already shares a conversation with, which for this app means their branch and
// department cohort. Expiry is enforced by Mongo (TTL index), not by a query filter, so a status
// cannot outlive its 24 hours even if a client asks for it directly.

const TTL_MS = 24 * 60 * 60 * 1000;
export const STATUS_EVENTS = { NEW: 'status:new', VIEWED: 'status:viewed' } as const;

// Who may see this person's status: everyone they share a conversation with, minus anyone either
// side has blocked. Computed at POST time and stored, so the audience cannot silently widen later.
async function audienceFor(userId: string): Promise<string[]> {
  const convs = await conversationRepo.listForUser(userId);
  const peers = new Set<string>();
  for (const c of convs) for (const p of c.participantIds) if (p !== userId) peers.add(p);
  const { blocked } = await chatSettingsRepo.get(userId);
  for (const b of blocked) peers.delete(b);
  const blockedBy = await chatSettingsRepo.blockedBy(userId);
  for (const b of blockedBy) peers.delete(b);
  return [...peers];
}

async function resolvePosters(ids: string[]) {
  const valid = [...new Set(ids)].filter((id) => Types.ObjectId.isValid(id)).map((id) => new Types.ObjectId(id));
  const users = await crmRepo.listUsers({ _id: { $in: valid } });
  const avatars = await userAvatars.mapFor(users.map((u) => String(u._id)));
  return new Map(users.map((u) => [String(u._id), {
    id: String(u._id),
    name: `${u.first_name ?? ''} ${u.last_name ?? ''}`.trim() || u.email,
    avatar: avatars[String(u._id)] ?? null,
  }]));
}

const toDTO = (s: StatusDoc, viewerId: string) => ({
  id: String(s._id),
  userId: s.userId,
  type: s.type,
  caption: s.caption,
  attachment: s.attachment,
  backgroundColor: s.backgroundColor,
  createdAt: s.createdAt,
  expiresAt: s.expiresAt,
  viewed: s.viewers.some((v) => v.userId === viewerId),
  // Only the poster is told who looked — same as WhatsApp, where viewers are private to the author.
  viewers: s.userId === viewerId ? s.viewers.map((v) => ({ userId: v.userId, at: v.at })) : [],
  viewCount: s.userId === viewerId ? s.viewers.length : 0,
});

export const statusService = {
  // Post a status. Text cards carry a colour; photo/video carry an uploaded attachment.
  async post(userId: string, input: { type: StatusDoc['type']; caption?: string; attachment?: Attachment; backgroundColor?: string }) {
    if (input.type !== 'text' && !input.attachment) throw BadRequest('A photo or video is required');
    if (input.type === 'text' && !input.caption?.trim()) throw BadRequest('Write something first');
    const audience = await audienceFor(userId);
    const doc = await StatusModel().create({
      userId,
      type: input.type,
      caption: input.caption ?? '',
      attachment: input.attachment ?? null,
      backgroundColor: input.backgroundColor ?? null,
      viewers: [],
      audience,
      expiresAt: new Date(Date.now() + TTL_MS),
    });
    emitToUsers(audience, STATUS_EVENTS.NEW, { userId });
    return toDTO(doc.toObject() as StatusDoc, userId);
  },

  // The status feed: mine first, then one entry per person who has posted, newest activity first —
  // the shape the Status tab lists. Unviewed rings sort above viewed ones, like WhatsApp.
  async feed(userId: string) {
    const docs = await StatusModel()
      .find({ $or: [{ userId }, { audience: userId }] })
      .sort({ createdAt: 1 })
      .lean<StatusDoc[]>();
    const posters = await resolvePosters(docs.map((d) => d.userId));
    const byUser = new Map<string, ReturnType<typeof toDTO>[]>();
    for (const d of docs) byUser.set(d.userId, [...(byUser.get(d.userId) ?? []), toDTO(d, userId)]);

    const entries = [...byUser.entries()].map(([id, items]) => ({
      userId: id,
      name: posters.get(id)?.name ?? 'Member',
      avatar: posters.get(id)?.avatar ?? null,
      items,
      lastAt: items[items.length - 1].createdAt,
      allViewed: items.every((i) => i.viewed),
      mine: id === userId,
    }));
    entries.sort((a, b) => {
      if (a.mine !== b.mine) return a.mine ? -1 : 1;               // my own status pinned to the top
      if (a.allViewed !== b.allViewed) return a.allViewed ? 1 : -1; // unseen before seen
      return new Date(b.lastAt).getTime() - new Date(a.lastAt).getTime();
    });
    return entries;
  },

  // Record a view. Idempotent, and never counts the poster looking at their own.
  async markViewed(userId: string, statusId: string) {
    if (!Types.ObjectId.isValid(statusId)) throw NotFound('Status not found');
    const doc = await StatusModel().findById(statusId).lean<StatusDoc>();
    if (!doc) throw NotFound('Status not found');
    if (doc.userId !== userId && !doc.audience.includes(userId)) throw Forbidden('Not available');
    if (doc.userId === userId || doc.viewers.some((v) => v.userId === userId)) return { ok: true };
    await StatusModel().updateOne({ _id: doc._id }, { $addToSet: { viewers: { userId, at: new Date() } } });
    emitToUsers([doc.userId], STATUS_EVENTS.VIEWED, { statusId, userId });
    return { ok: true };
  },

  async remove(userId: string, statusId: string) {
    if (!Types.ObjectId.isValid(statusId)) throw NotFound('Status not found');
    const doc = await StatusModel().findById(statusId).lean<StatusDoc>();
    if (!doc) throw NotFound('Status not found');
    if (doc.userId !== userId) throw Forbidden('You can only delete your own status');
    await StatusModel().deleteOne({ _id: doc._id });
    return { ok: true };
  },
};
