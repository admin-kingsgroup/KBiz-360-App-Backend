/* eslint-disable no-console */
// One-off: turn every OPEN reminder (pending / review) into a Smart Connect task (spec 2026-11-16 —
// "Reminders are removed"; the owner's call: convert the open ones rather than drop them).
//
//   on the server (inside the app container, which has the DB env):
//     docker exec kb360 node dist/mongo/tasks/convertReminders.cli.js            # dry run (default)
//     docker exec kb360 node dist/mongo/tasks/convertReminders.cli.js --apply    # writes
//   locally: npx ts-node src/mongo/tasks/convertReminders.cli.ts [--apply]
//
// Per reminder copy (one doc per assignee): title = the text (first 120 chars; the full text goes to
// the description when longer), assignee = forId, assigner = byId, due date kept (may be empty),
// branch = the assignee's first branch, status Accepted (pending) or Done – to close (review, so the
// writer still checks it), screenshot → attachment, source 'reminder'. Already-overdue ones have their
// alerts stamped so the conversion does not set off a burst of "overdue" pushes. No chat is created:
// the task's chat is made the first time someone opens it. --apply then marks the reminder approved
// (archived) with convertedToTaskId, so the old reminder screens and sweep stop showing / pushing it.
// Idempotent: a reminder that already has a task (legacyReminderId) is skipped.
import 'dotenv/config';
import { Types } from 'mongoose';
import { connectMongo, disconnectMongo, appDb } from '../connection';
import { config } from '../../config';
import { crmRepo } from '../crm.repo';
import { ReminderModel, type ReminderDoc } from '../reminders/reminder.model';
import { TaskModel, TaskHistoryModel } from './task.model';
import { TITLE_MAX } from './task.types';

const APPLY = process.argv.includes('--apply');
const ALLOW_DB = process.argv.includes('--allow-db'); // for a test copy whose app DB is not kb360_app

async function main(): Promise<void> {
  await connectMongo();
  const dbName = appDb().name;
  console.log(`App DB: ${dbName} · CRM DB: ${config.mongo.crmDb} · mode: ${APPLY ? 'APPLY' : 'dry run'}`);
  if (APPLY && dbName !== 'kb360_app' && !ALLOW_DB) throw new Error(`Refusing to write to "${dbName}" (expected kb360_app; pass --allow-db for a test copy)`);

  const open = await ReminderModel().find({ state: { $in: ['pending', 'review'] } }).sort({ createdAt: 1 }).lean<ReminderDoc[]>();
  const already = new Set(
    (await TaskModel().find({ legacyReminderId: { $in: open.map((r) => String(r._id)) } }).select('legacyReminderId').lean<{ legacyReminderId: string }[]>())
      .map((t) => t.legacyReminderId),
  );
  const people = new Map<string, { name: string; branchId: string | null }>();
  const ids = [...new Set(open.flatMap((r) => [r.forId, r.byId]))].filter((id) => Types.ObjectId.isValid(id));
  for (const u of await crmRepo.listUsers({ _id: { $in: ids.map((id) => new Types.ObjectId(id)) } })) {
    people.set(String(u._id), { name: `${u.first_name ?? ''} ${u.last_name ?? ''}`.trim() || u.email, branchId: u.branch_ids?.[0] ? String(u.branch_ids[0]) : null });
  }
  const branchIds = [...new Set([...people.values()].map((p) => p.branchId).filter((b): b is string => !!b))];
  const companyOf = new Map((await crmRepo.branchesByIds(branchIds.map((b) => new Types.ObjectId(b)))).map((b) => [String(b._id), b.company_id ? String(b.company_id) : null]));

  const now = new Date();
  const counts = { open: open.length, skippedDone: 0, skippedNoBranch: 0, toConvert: 0, pastDue: 0, undated: 0, review: 0 };
  const perAssignee = new Map<string, number>();
  for (const r of open) {
    const rid = String(r._id);
    if (already.has(rid)) { counts.skippedDone += 1; continue; }
    const assignee = people.get(r.forId);
    const branchId = assignee?.branchId ?? null;
    if (!branchId) { counts.skippedNoBranch += 1; console.log(`  skip ${rid}: ${assignee?.name ?? r.forId} has no branch — "${r.text.slice(0, 60)}"`); continue; }
    counts.toConvert += 1;
    if (r.state === 'review') counts.review += 1;
    if (!r.dueAt) counts.undated += 1;
    const pastDue = !!r.dueAt && r.dueAt.getTime() < now.getTime();
    if (pastDue) counts.pastDue += 1;
    perAssignee.set(assignee?.name ?? r.forId, (perAssignee.get(assignee?.name ?? r.forId) ?? 0) + 1);
    if (!APPLY) continue;

    const text = r.text.trim();
    const title = text.length > TITLE_MAX ? `${text.slice(0, TITLE_MAX - 1).trimEnd()}…` : text;
    const self = r.forId === r.byId;
    const status = r.state === 'review' && !self ? 'done' : 'accepted';
    const stamp = pastDue ? now : null;
    const taskId = new Types.ObjectId();
    await TaskModel().collection.insertOne({
      _id: taskId,
      title,
      description: text.length > TITLE_MAX ? text : '',
      companyId: companyOf.get(branchId) ?? null,
      branchId,
      assignedTo: r.forId,
      assignedBy: r.byId,
      watchers: [],
      priority: 'normal',
      dueAt: r.dueAt ?? null,
      status,
      requestedDueAt: null,
      waitingOn: null,
      attachments: r.imageUrl ? [{ url: r.imageUrl, name: 'screenshot.jpg', size: 0, mime: 'image/jpeg', uploadedBy: r.byId, uploadedAt: r.createdAt }] : [],
      repeat: { kind: 'none' },
      parentRecurringId: null,
      nextSpawnedAt: null,
      chatId: null,
      link: null,
      source: 'reminder',
      legacyReminderId: rid,
      assignedAt: r.createdAt,
      acceptedAt: r.createdAt,
      doneAt: status === 'done' ? r.completedAt ?? now : null,
      closedAt: null,
      cancelledAt: null,
      alerts: { dueTomorrowAt: stamp, due2hAt: stamp, overdueAt: stamp, acceptNudgeAt: now },
      createdAt: r.createdAt,
      updatedAt: now,
    });
    await TaskHistoryModel().collection.insertOne({
      taskId: String(taskId), userId: r.byId, field: 'created', oldValue: null, newValue: title, comment: 'Converted from a reminder', createdAt: now,
    });
    await ReminderModel().collection.updateOne({ _id: r._id }, { $set: { state: 'approved', approvedAt: now, convertedToTaskId: String(taskId) } });
  }

  console.log('\nOpen reminders:', counts);
  console.log('Per assignee:', Object.fromEntries([...perAssignee.entries()].sort((a, b) => b[1] - a[1])));
  if (!APPLY) console.log('\nDry run — nothing written. Re-run with --apply to convert.');
  await disconnectMongo();
}

void main().catch(async (e) => { console.error(e); await disconnectMongo().catch(() => undefined); process.exit(1); });
