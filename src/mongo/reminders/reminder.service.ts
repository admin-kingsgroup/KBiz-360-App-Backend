import { Types } from 'mongoose';
import { NotFound, BadRequest, Forbidden } from '../../common/errors';
import { crmRepo, type CrmUser } from '../crm.repo';
import { accessService, type MongoAccess } from '../access';
import { emitToUser } from '../chat/chat.events';
import { reminderRepo } from './reminder.repository';
import { reminderPush } from './reminder.push';
import type { ReminderDoc } from './reminder.model';

export type ReminderTab = 'forme' | 'iset' | 'review' | 'all' | 'archive';

// ── display helpers (derive avatar metadata from CRM users; ids are CRM user _id) ──
const PALETTE = ['#9A6CF0', '#4F8BFF', '#37B6A4', '#E8A13A', '#E3674E', '#0C0E14'];
const colorFor = (id: string): string => PALETTE[[...id].reduce((n, c) => n + c.charCodeAt(0), 0) % PALETTE.length];
const nameOf = (u: CrmUser): string => `${u.first_name ?? ''} ${u.last_name ?? ''}`.trim() || u.email || 'Unknown';
const initialsOf = (name: string): string => name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]).join('').toUpperCase() || '?';
const roleLabel = (roleName?: string): string => (roleName ?? '').split('_').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

interface Meta { name: string; initials: string; color: string }
async function resolveMeta(ids: string[]): Promise<Map<string, Meta>> {
  const oids = [...new Set(ids)].filter((id) => Types.ObjectId.isValid(id)).map((id) => new Types.ObjectId(id));
  const map = new Map<string, Meta>();
  if (!oids.length) return map;
  const users = await crmRepo.listUsers({ _id: { $in: oids } });
  for (const u of users) { const name = nameOf(u); map.set(String(u._id), { name, initials: initialsOf(name), color: colorFor(String(u._id)) }); }
  return map;
}

// The ReminderRecord shape the frontend expects (display fields embedded).
export interface ReminderRecordDTO {
  id: string; text: string; section: string;
  forId: string; forName: string; forInitials: string; forColor: string;
  byId: string; byName: string; byInitials: string; byColor: string;
  state: ReminderDoc['state']; when?: string; overdue?: boolean; date?: string;
  dueAt?: string; // ISO due timestamp (when the reminder fires)
  completedAt?: number; approvedAt?: number;
}

function toRecord(r: ReminderDoc, meta: Map<string, Meta>): ReminderRecordDTO {
  const f = meta.get(r.forId) ?? { name: 'Unknown', initials: '?', color: colorFor(r.forId) };
  const b = meta.get(r.byId) ?? { name: 'Unknown', initials: '?', color: colorFor(r.byId) };
  // Overdue is derived live from the real due time, not the stored flag — a pending reminder
  // becomes overdue the moment its dueAt passes, with no write needed.
  const overdue = r.state === 'pending' && !!r.dueAt && r.dueAt.getTime() < Date.now();
  return {
    id: String(r._id), text: r.text, section: r.section,
    forId: r.forId, forName: f.name, forInitials: f.initials, forColor: f.color,
    byId: r.byId, byName: b.name, byInitials: b.initials, byColor: b.color,
    state: r.state, when: r.whenLabel ?? undefined, overdue, date: r.dueDate ?? undefined,
    dueAt: r.dueAt?.toISOString(),
    completedAt: r.completedAt?.getTime(), approvedAt: r.approvedAt?.getTime(),
  };
}

// Parse an optional ISO due timestamp from the client; invalid dates are treated as absent.
function parseDueAt(iso?: string | null): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

export const remindersService = {
  // GET /reminders?tab=&viewAs= — tab filtering + server-side grouping, on real users.
  async list(userId: string, opts: { tab: ReminderTab }) {
    const viewer = await accessService.accessForUserId(userId);
    const me = userId;

    let source: ReminderDoc[];
    if (opts.tab === 'archive') {
      source = await reminderRepo.listApproved(me);
    } else {
      source = await reminderRepo.listLive();
    }

    let visible: ReminderDoc[];
    if (opts.tab === 'forme') visible = source.filter((r) => r.state === 'pending' && r.forId === me);
    else if (opts.tab === 'iset') visible = source.filter((r) => r.state === 'pending' && r.byId === me && r.forId !== me);
    else if (opts.tab === 'review') visible = source.filter((r) => r.state === 'review' && r.byId === me);
    else if (opts.tab === 'archive') visible = source;
    else visible = await this.filterAll(source, me, viewer); // 'all' — chain-of-command visibility

    // Resolve display metadata for everyone referenced.
    const meta = await resolveMeta(visible.flatMap((r) => [r.forId, r.byId]));
    const records = visible.map((r) => toRecord(r, meta));

    // Group by the "counterparty": who set it (For me) vs who it's for (everything else).
    const counterpartyOf = (r: ReminderRecordDTO): { id: string; name: string; initials: string; color: string } =>
      opts.tab === 'forme'
        ? { id: r.byId, name: r.byName, initials: r.byInitials, color: r.byColor }
        : opts.tab === 'archive' && r.forId === me
          ? { id: r.byId, name: r.byName, initials: r.byInitials, color: r.byColor }
          : { id: r.forId, name: r.forName, initials: r.forInitials, color: r.forColor };

    const roleByUser = await this.rolesFor([...new Set(records.map((r) => counterpartyOf(r).id))]);
    const byKey = new Map<string, { key: string; mode: 'person'; name: string; initials: string; avColor: string; sub: string; items: ReminderRecordDTO[] }>();
    for (const r of records) {
      const cp = counterpartyOf(r);
      let g = byKey.get(cp.id);
      if (!g) { g = { key: cp.id, mode: 'person', name: cp.name, initials: cp.initials, avColor: cp.color, sub: roleLabel(roleByUser.get(cp.id)), items: [] }; byKey.set(cp.id, g); }
      g.items.push(r);
    }
    const groups = [...byKey.values()];

    const reviewCount = await reminderRepo.countReview(me);
    return {
      tab: opts.tab,
      isAll: opts.tab === 'all',
      reviewCount,
      viewer: opts.tab === 'all' ? { role: viewer?.roleName } : { id: me },
      groups,
      visible: records,
    };
  },

  // "All" tab visibility: managers see everything; others see their own + strict subordinates
  // (chain-of-command, branch-scoped) via accessService.canSee.
  async filterAll(source: ReminderDoc[], me: string, viewer: MongoAccess | null): Promise<ReminderDoc[]> {
    if (viewer?.canManage) return source;
    const forIds = [...new Set(source.map((r) => r.forId))];
    const access = await this.accessMap(forIds);
    return source.filter((r) => {
      if (r.forId === me || r.byId === me) return true;
      const a = access.get(r.forId);
      return !!(viewer && a && accessService.canSee(viewer, { level: a.level, branchIds: a.branchIds ?? [] }));
    });
  },

  async accessMap(ids: string[]): Promise<Map<string, MongoAccess>> {
    const map = new Map<string, MongoAccess>();
    await Promise.all(ids.map(async (id) => { const a = await accessService.accessForUserId(id); if (a) map.set(id, a); }));
    return map;
  },
  async rolesFor(ids: string[]): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    await Promise.all(ids.map(async (id) => { const a = await accessService.accessForUserId(id); if (a) map.set(id, a.roleName); }));
    return map;
  },

  // POST /reminders — creator = current user; assignee must be a real user.
  async create(userId: string, body: { text: string; forId: string; when?: string; section?: string; dueAt?: string }): Promise<ReminderRecordDTO> {
    const target = await crmRepo.getUserById(body.forId);
    if (!target) throw BadRequest('Unknown assignee');
    const doc = await reminderRepo.create({
      text: body.text, section: body.section ?? 'today', forId: body.forId, byId: userId,
      state: 'pending', whenLabel: body.when ?? null, dueAt: parseDueAt(body.dueAt),
    });
    const meta = await resolveMeta([doc.forId, doc.byId]);
    // Notify the assignee (not self): realtime badge + a push "X created a reminder for you".
    if (body.forId !== userId) {
      emitToUser(body.forId, 'reminder:new', { id: String(doc._id) });
      void reminderPush.sendAssigned(body.forId, meta.get(userId)?.name ?? 'Someone', body.text, String(doc._id));
    }
    return toRecord(doc.toObject() as ReminderDoc, meta);
  },

  // PATCH /reminders/:id — complete (assignee) / approve (creator) / reassign (creator) / edit (creator).
  async patch(id: string, body: { action?: 'complete' | 'approve'; forId?: string; text?: string; when?: string; section?: string; dueAt?: string }, userId: string) {
    const r = await reminderRepo.byId(id);
    if (!r) throw NotFound('Reminder not found');

    // Reassign: the creator routes it to a (possibly different) assignee and resets it to pending.
    // dueNotifiedAt resets so the NEW assignee also gets the due-time push.
    if (body.forId && body.forId !== r.forId) {
      if (r.byId !== userId) throw Forbidden('Only the creator can reassign this reminder');
      const target = await crmRepo.getUserById(body.forId);
      if (!target) throw BadRequest('Unknown assignee');
      await reminderRepo.update(id, { forId: body.forId, state: 'pending', completedAt: null, dueNotifiedAt: null });
      if (body.forId !== userId) {
        emitToUser(body.forId, 'reminder:new', { id });
        const meta = await resolveMeta([userId]);
        void reminderPush.sendAssigned(body.forId, meta.get(userId)?.name ?? 'Someone', r.text, id);
      }
      return this.result(id, 'updated');
    }

    if (body.action === 'complete') {
      if (r.forId !== userId) throw Forbidden('Only the assignee can complete this reminder');
      const selfAssigned = r.byId === r.forId;
      const now = new Date();
      await reminderRepo.update(id, selfAssigned ? { state: 'approved', completedAt: now, approvedAt: now } : { state: 'review', completedAt: now });
      // Tell the creator their reminder was completed (badge + push), like Apple Reminders' shared-list updates.
      if (!selfAssigned) {
        emitToUser(r.byId, 'reminder:update', { id });
        const meta = await resolveMeta([userId]);
        void reminderPush.sendCompleted(r.byId, meta.get(userId)?.name ?? 'Someone', r.text, id);
      }
      return this.result(id, selfAssigned ? 'archived' : 'review');
    }
    if (body.action === 'approve') {
      if (r.byId !== userId) throw Forbidden('Only the creator can approve this reminder');
      await reminderRepo.update(id, { state: 'approved', approvedAt: new Date() });
      // Tell the assignee their completed work was approved.
      if (r.forId !== userId) {
        emitToUser(r.forId, 'reminder:update', { id });
        const meta = await resolveMeta([userId]);
        void reminderPush.sendApproved(r.forId, meta.get(userId)?.name ?? 'Someone', r.text, id);
      }
      return this.result(id, 'approved');
    }
    // field edit (creator only). A changed due time re-arms the due-time push.
    if (r.byId !== userId) throw Forbidden('Only the creator can edit this reminder');
    const nextDueAt = body.dueAt !== undefined ? parseDueAt(body.dueAt) : r.dueAt;
    await reminderRepo.update(id, {
      text: body.text ?? r.text, section: body.section ?? r.section, whenLabel: body.when ?? r.whenLabel,
      dueAt: nextDueAt, ...(body.dueAt !== undefined ? { dueNotifiedAt: null } : {}),
    });
    return this.result(id, 'updated');
  },

  // Due-time sweep (called on an interval from main): push "⏰ Reminder due" to the assignee of
  // every pending reminder whose dueAt has passed and hasn't been notified yet.
  async sweepDue(): Promise<number> {
    const due = await reminderRepo.listDueUnnotified(new Date());
    for (const r of due) {
      await reminderRepo.update(String(r._id), { dueNotifiedAt: new Date(), overdue: true });
      emitToUser(r.forId, 'reminder:update', { id: String(r._id) });
      void reminderPush.sendDue(r.forId, r.text, String(r._id));
    }
    return due.length;
  },

  async result(id: string, result: 'archived' | 'review' | 'approved' | 'updated') {
    const updated = (await reminderRepo.byId(id))!;
    const meta = await resolveMeta([updated.forId, updated.byId]);
    return { reminder: toRecord(updated, meta), result };
  },

  // DELETE /reminders/:id — creator or a manager.
  async remove(id: string, userId: string): Promise<void> {
    const r = await reminderRepo.byId(id);
    if (!r) throw NotFound('Reminder not found');
    const access = await accessService.accessForUserId(userId);
    if (r.byId !== userId && !access?.canManage) throw Forbidden('Only the creator or a manager can delete this reminder');
    await reminderRepo.remove(id);
  },
};
