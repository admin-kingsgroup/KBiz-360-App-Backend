import crypto from 'crypto';
import type { Reminder as PReminder, User as PUser } from '@prisma/client';
import { prisma } from '../../db/prisma';
import { NotFound, BadRequest, Forbidden } from '../../common/errors';
import { writeAudit } from '../../common/audit';
import { accessService } from '../access/access.service';
import { applyCanSee, groupReminders } from '../../domain/logic/reminderGrouping';
import { ROLE_DEFS } from '../../domain/constants/roles';
import { ROLE_VIEWERS } from '../../domain/data/users';
import { CURRENT_USER_ID, type ReminderRecord } from '../../domain/data/reminders';
import type { RoleKey } from '../../domain/types';

export type ReminderTab = 'forme' | 'iset' | 'review' | 'all';

// Prisma Reminder row → the ReminderRecord shape the foundation grouping/canSee functions expect.
function toRecord(r: PReminder): ReminderRecord {
  return {
    id: r.id,
    title: r.title ?? undefined,
    text: r.text ?? undefined,
    section: r.section,
    forId: r.forId,
    forName: r.forName,
    forInitials: r.forInitials ?? undefined,
    forColor: r.forColor ?? undefined,
    byId: r.byId,
    byName: r.byName ?? undefined,
    byInitials: r.byInitials ?? undefined,
    byColor: r.byColor ?? undefined,
    state: r.state,
    when: r.whenLabel ?? undefined,
    overdue: r.overdue ?? undefined,
    date: r.dueDate ?? undefined,
    completedAt: r.completedAt?.getTime(),
    approvedAt: r.approvedAt?.getTime(),
  };
}

// The authed user's REMINDER-space identity. Mirrors the app's CURRENT_USER_ID ('a' = Afshin):
// the linked ReminderViewer if any, else 'a' (single-user fallback, matching the frontend).
async function resolveCurrent(userId: string): Promise<{ currentId: string; user: PUser }> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw Forbidden('Session user not found');
  const linked = await prisma.reminderViewer.findFirst({ where: { userId } });
  return { currentId: linked?.id ?? CURRENT_USER_ID, user };
}

export const remindersService = {
  // GET /reminders — reproduces RemindersScreen: tab filters (For me/I set/Review hardcoded to the
  // current user) + All tab via applyCanSee(ROLE_VIEWERS[viewAs]); then groupReminders.
  async list(userId: string, authRole: string, opts: { tab: ReminderTab; viewAs?: RoleKey }) {
    const { currentId } = await resolveCurrent(userId);
    const personMeta = await accessService.personMeta();
    const rows = await prisma.reminder.findMany({ orderBy: { createdAt: 'asc' } });
    const all = rows.map(toRecord);
    const live = all.filter((r) => r.state !== 'approved');
    const isAll = opts.tab === 'all';

    // viewAs override is SUPER-only (the role picker shows for Super Admin only); else the real role.
    const effectiveRole = (authRole === 'SUPER_ADMIN' && opts.viewAs ? opts.viewAs : authRole) as RoleKey;

    let visible: ReminderRecord[];
    if (opts.tab === 'forme') {
      visible = live.filter((r) => r.state === 'pending' && r.forId === currentId);
    } else if (opts.tab === 'iset') {
      visible = live.filter((r) => r.state === 'pending' && r.byId === currentId && r.forId !== currentId);
    } else if (opts.tab === 'review') {
      visible = live.filter((r) => r.state === 'review' && r.byId === currentId);
    } else {
      const viewer = ROLE_VIEWERS[effectiveRole] ?? ROLE_VIEWERS.SUPER_ADMIN;
      visible = applyCanSee(live, viewer, personMeta) as ReminderRecord[];
    }

    const reviewCount = all.filter((r) => r.state === 'review' && r.byId === currentId).length;
    const groups = groupReminders(visible, { isAll, personMeta, roleDefs: ROLE_DEFS });
    return {
      tab: opts.tab,
      isAll,
      reviewCount,
      viewer: isAll ? { role: effectiveRole } : { id: currentId },
      groups,
      visible,
    };
  },

  // POST /reminders — mirrors NewReminderScreen.save (byId = current user; display from viewer/user).
  async create(userId: string, body: { text: string; forId: string; when?: string; section?: string }, actorId: string) {
    const { currentId, user } = await resolveCurrent(userId);
    const forViewer = await prisma.reminderViewer.findUnique({ where: { id: body.forId } });
    if (!forViewer) throw BadRequest('Unknown assignee (forId)');
    const isSelf = body.forId === currentId;

    const created = await prisma.reminder.create({
      data: {
        id: `r-${crypto.randomUUID()}`,
        text: body.text,
        section: body.section ?? 'today',
        forId: body.forId,
        forName: isSelf ? user.name : forViewer.name ?? forViewer.id,
        forInitials: isSelf ? user.initials : forViewer.initials,
        forColor: forViewer.color,
        byId: currentId,
        byName: user.name,
        byInitials: user.initials,
        byColor: user.color,
        state: 'pending',
        whenLabel: body.when ?? null,
      },
    });
    await writeAudit({ actorId, action: 'CREATE', entity: 'Reminder', entityId: created.id, after: toRecord(created) });
    return toRecord(created);
  },

  // PATCH /reminders/:id — state machine (verbatim from remindersStore) or simple field edits.
  async patch(id: string, body: { action?: 'complete' | 'approve'; text?: string; when?: string; section?: string }, actorId: string) {
    const r = await prisma.reminder.findUnique({ where: { id } });
    if (!r) throw NotFound('Reminder not found');
    const before = toRecord(r);

    if (body.action === 'complete') {
      const selfAssigned = r.byId === r.forId; // verbatim remindersStore.complete
      const now = new Date();
      const updated = await prisma.reminder.update({
        where: { id },
        data: selfAssigned
          ? { state: 'approved', completedAt: now, approvedAt: now }
          : { state: 'review', completedAt: now },
      });
      await writeAudit({ actorId, action: 'COMPLETE', entity: 'Reminder', entityId: id, before, after: toRecord(updated) });
      return { reminder: toRecord(updated), result: selfAssigned ? ('archived' as const) : ('review' as const) };
    }

    if (body.action === 'approve') {
      const updated = await prisma.reminder.update({ where: { id }, data: { state: 'approved', approvedAt: new Date() } });
      await writeAudit({ actorId, action: 'APPROVE', entity: 'Reminder', entityId: id, before, after: toRecord(updated) });
      return { reminder: toRecord(updated), result: 'approved' as const };
    }

    const updated = await prisma.reminder.update({
      where: { id },
      data: {
        text: body.text ?? r.text,
        section: body.section ?? r.section,
        whenLabel: body.when ?? r.whenLabel,
      },
    });
    await writeAudit({ actorId, action: 'UPDATE', entity: 'Reminder', entityId: id, before, after: toRecord(updated) });
    return { reminder: toRecord(updated), result: 'updated' as const };
  },

  // DELETE /reminders/:id — creator (byId === current) or a manager (canManage) may delete.
  async remove(userId: string, id: string, actorId: string) {
    const { currentId } = await resolveCurrent(userId);
    const r = await prisma.reminder.findUnique({ where: { id } });
    if (!r) throw NotFound('Reminder not found');
    const access = await accessService.accessForUserId(userId);
    const isOwner = r.byId === currentId;
    if (!isOwner && !access?.canManage) throw Forbidden('Only the creator or a manager can delete this reminder');
    await prisma.reminder.delete({ where: { id } });
    await writeAudit({ actorId, action: 'DELETE', entity: 'Reminder', entityId: id, before: toRecord(r) });
  },
};
