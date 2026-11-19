import { Types } from 'mongoose';
import { crmRepo } from '../crm.repo';
import { reportChat } from '../alerts/reportChat.service';
import type { TaskDoc } from './task.model';
import type { TaskPerson } from './task.people';
import { shortStamp } from './task.time';

// A new task is shared in its branch's group — "BOM Operations" or "BOM Accounts", by the department the giver
// picked — "so the team knows" (owner, 2026-11-19). Sent once, at creation, as KBiz Books (like the ERP's
// concerns), through the same report pipe and group-name rule (reportGroupName 'operations' / 'accounts').
//
// The group's members are mostly NOT on the task and cannot open it in the app, so the message carries what
// they need to know itself. It never decides anything: a branch with no such group (KGD, INB, …) or any
// failure is logged and the task stands.

// The CRM re-coded the Africa branches with an H (HNBO / HDAR / HFBM); their groups kept the short code.
const ROOM_CODE: Record<string, string> = { HNBO: 'NBO', HDAR: 'DAR', HFBM: 'FBM' };
export const roomCodeOf = (code: string | null | undefined): string => {
  const c = String(code ?? '').trim().toUpperCase();
  return ROOM_CODE[c] ?? c;
};

const PRIORITY: Record<TaskDoc['priority'], string> = { urgent: 'Urgent', high: 'High', normal: 'Normal' };
const DESCRIPTION_SHOWN = 600;

export function taskGroupMessage(task: TaskDoc, names: { assignee: string; giver: string; watchers: string[] }, tz: string): { title: string; body: string } {
  const lines = [
    `For: ${names.assignee} · Given by: ${names.giver}`,
    `Due: ${task.dueAt ? shortStamp(task.dueAt, tz) : 'no due date'} · Priority: ${PRIORITY[task.priority] ?? 'Normal'}`,
  ];
  if (names.watchers.length) lines.push(`Watching: ${names.watchers.join(', ')}`);
  const description = (task.description ?? '').trim();
  if (description) lines.push(description.length > DESCRIPTION_SHOWN ? `${description.slice(0, DESCRIPTION_SHOWN).trimEnd()}…` : description);
  if (task.link) lines.push(`From KBiz Books: ${task.link.label} — ${task.link.url}`);
  return { title: `*📋 New task — ${task.title}*`, body: lines.join('\n') };
}

/** Post the task into its branch's department group. Resolves to the group's name, or null when it was not
 *  shared (no department, no such group, or a failure) — never throws. */
export async function shareTaskInBranchGroup(task: TaskDoc, people: Map<string, TaskPerson>): Promise<string | null> {
  if (!task.department) return null;
  try {
    const branch = Types.ObjectId.isValid(task.branchId) ? (await crmRepo.branchesByIds([new Types.ObjectId(task.branchId)]))[0] : null;
    const branchCode = roomCodeOf(branch?.code);
    if (!branchCode) return null;
    const name = (id: string): string => people.get(id)?.name ?? 'Someone';
    const tz = people.get(task.assignedTo)?.tz ?? 'Asia/Kolkata';
    const message = taskGroupMessage(task, { assignee: name(task.assignedTo), giver: name(task.assignedBy), watchers: task.watchers.map((w) => name(w.userId)) }, tz);
    const out = await reportChat.post({ branchCode, group: task.department, ...message, dedupeKey: `task-${String(task._id)}` });
    return out.group;
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(`[task-group] task ${String(task._id)} not shared: ${(e as Error).message}`);
    return null;
  }
}
