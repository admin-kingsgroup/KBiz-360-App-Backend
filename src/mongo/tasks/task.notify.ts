import { mailer } from '../../mailer';
import { emitToUser } from '../chat/chat.events';
import { TaskNotificationModel, type TaskDoc, type TaskPushRecord } from './task.model';
import { taskPeople, unknownPerson, type TaskPerson } from './task.people';
import { taskPush } from './task.push';
import { inQuietHours, shortStamp } from './task.time';

// Task notifications (spec §6, minus escalation — owner 2026-11-16). Every event goes to the in-app
// list, a server push (Expo → FCM/APNs) and an email. Push respects quiet hours (22:00–07:00 in the
// recipient's zone) unless the task is Urgent; email always goes. The actor is never told about
// their own action. What Expo answered about the push is kept on the notification (task.push.ts).
export type TaskEvent =
  | 'assigned' | 'reassigned' | 'reassigned_away' | 'watcher_added'
  | 'accepted' | 'date_change_requested' | 'waiting' | 'done'
  | 'closed' | 'reopened' | 'cancelled'
  | 'due_changed' | 'priority_changed'
  | 'accept_nudge' | 'due_tomorrow' | 'due_2h' | 'overdue'
  | 'mention';

export interface NotifyContext {
  actorId?: string | null;
  comment?: string | null;
  newAssigneeName?: string;
  preview?: string; // the chat message, for a mention
  noPush?: boolean; // the chat already pushed this (an @mention) — in-app list + email only
}

// The words of one notification, read in the recipient's zone.
export function wording(event: TaskEvent, task: Pick<TaskDoc, 'title' | 'dueAt' | 'priority' | 'requestedDueAt'>, actorName: string, to: TaskPerson, ctx: NotifyContext): { title: string; body: string } {
  const due = task.dueAt ? shortStamp(task.dueAt, to.tz) : 'no due date';
  const why = ctx.comment ? ` · ${ctx.comment}` : '';
  const t = task.title;
  switch (event) {
    case 'assigned':
    case 'reassigned': return { title: `${actorName} assigned you a task`, body: `${t} · due ${due}` };
    case 'reassigned_away': return { title: `${actorName} moved a task to ${ctx.newAssigneeName ?? 'someone else'}`, body: t };
    case 'watcher_added': return { title: `${actorName} added you as a watcher`, body: `${t} · due ${due}` };
    case 'accepted': return { title: `${actorName} accepted your task`, body: `${t} · due ${due}` };
    case 'date_change_requested': return { title: `${actorName} asked for a new due date`, body: `${t} → ${task.requestedDueAt ? shortStamp(task.requestedDueAt, to.tz) : '?'}${why}` };
    case 'waiting': return { title: `${actorName} is waiting on someone`, body: `${t}${why}` };
    case 'done': return { title: `${actorName} marked a task Done – to close`, body: `${t} · please check it` };
    case 'closed': return { title: `${actorName} closed a task`, body: t };
    case 'reopened': return { title: `${actorName} reopened a task`, body: `${t}${why}` };
    case 'cancelled': return { title: `${actorName} cancelled a task`, body: `${t}${why}` };
    case 'due_changed': return { title: 'Due date changed', body: `${t} · now due ${due}` };
    case 'priority_changed': return { title: `Priority changed to ${task.priority === 'urgent' ? 'Urgent' : task.priority === 'high' ? 'High' : 'Normal'}`, body: t };
    case 'accept_nudge': return { title: 'A task is waiting for you to accept it', body: `${t} · due ${due}` };
    case 'due_tomorrow': return { title: 'Task due tomorrow', body: `${t} · due ${due}` };
    case 'due_2h': return { title: 'Task due in 2 hours', body: `${t} · due ${due}` };
    case 'overdue': return { title: '⚠️ Task overdue', body: `${t} · was due ${due}` };
    case 'mention': return { title: `${actorName} mentioned you in a task chat`, body: `${t}: ${ctx.preview ?? ''}`.trim() };
    default: return { title: 'Task update', body: t };
  }
}

export const taskNotify = {
  async send(event: TaskEvent, task: TaskDoc, recipients: string[], ctx: NotifyContext = {}): Promise<void> {
    const actorId = ctx.actorId ?? null;
    const ids = [...new Set(recipients)].filter((id) => !!id && id !== actorId);
    if (!ids.length) return;
    const people = await taskPeople.resolve(actorId ? [...ids, actorId] : ids);
    const actorName = actorId ? people.get(actorId)?.name ?? 'Someone' : 'KBiz360';
    const now = new Date();
    const taskId = String(task._id);
    await Promise.all(ids.map(async (uid) => {
      const to = people.get(uid) ?? unknownPerson(uid);
      const { title, body } = wording(event, task, actorName, to, ctx);
      const channels: Array<'push' | 'email' | 'inapp'> = ['inapp'];
      let push: TaskPushRecord | null = null; // what Expo said; null = no push was tried
      try {
        const urgent = task.priority === 'urgent';
        if (!ctx.noPush && (urgent || !inQuietHours(now, to.tz))) {
          push = await taskPush.toUser(uid, { title, body, urgent, data: { type: 'task', taskId, chatId: task.chatId, event } });
          if (push && push.accepted > 0) channels.push('push');
        }
        if (to.email && await mailer.send({
          to: to.email,
          subject: `[Task] ${task.title} — ${title}`,
          text: `${title}\n\n${body}\n\nOpen KBiz360 Smart Connect → Tasks to see it.`,
        })) channels.push('email');
        await TaskNotificationModel().create({ userId: uid, taskId, event, title, body, channels, push, sentAt: now, openedAt: null });
        emitToUser(uid, 'task:notification', { taskId, event, title, body });
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn(`[task-notify] ${event} → ${uid} failed:`, (e as Error).message);
      }
    }));
  },
  sendInboxAndEmail(event: TaskEvent, task: TaskDoc, recipients: string[], ctx: NotifyContext = {}): Promise<void> {
    return this.send(event, task, recipients, { ...ctx, noPush: true });
  },
};
