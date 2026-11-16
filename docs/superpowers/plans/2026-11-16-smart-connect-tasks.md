# Smart Connect Tasks & Task Chat — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace KB360 Smart Connect reminders with tasks (one assignee, statuses, history, watchers), each with its own always-open chat, server push + email alerts, lists and a dashboard.

**Architecture:** New `src/mongo/tasks/` module in the app backend (Mongo `kb360_app`: `tasks`, `task_history`, `task_notifications`, `task_digests`). Pure rule/time logic in `task.rules.ts` / `task.time.ts` (unit-tested, no I/O); `task.service.ts` orchestrates repo + chat + notify. A task chat is a conversation `type: 'task'` with `taskId`, managed only by the task service. App (Expo RN) gets a Tasks tab in place of Reminders, task detail/create screens, a pinned task card + quick actions in the chat screen, and a Task chats filter.

**Tech Stack:** Node 20 + Express + TypeScript + Mongoose 9 + zod + Jest (backend, repos mocked in tests); Expo SDK 56 + expo-router + Zustand + NativeWind + Jest (app).

**Spec:** `~/Downloads/Smart Connect Tasks & Task Chat – Spec.pdf` (Afshin, 2026-11-16) **as amended by the decisions below — the decisions win where they differ.**

## Decisions that override the PDF (user, 2026-11-16)

1. **Anyone can assign a task to anyone.** No "Assign tasks" permission.
2. **Visibility is hierarchy-wise.** Viewer sees a task if they are assigner, assignee or watcher, or `accessService.canSee(viewer, assignee)` (strictly lower role level, branch overlap; level ≤ 2 = company-wide; Super Admin = everything). Hierarchy viewers get read-only task + read-only chat; they post only after joining as a watcher.
3. **No escalation.** Drop "still overdue after 1 day → reporting manager / Chairman". Keep: due tomorrow, due in 2 h, overdue at due time (assignee + assigner), 4-working-hour acceptance nudge, 8 am digest.
4. **Task chat is always open.** No read-only, no 423, no grace period. Close/Cancel/Reopen still post a system message. Closed/cancelled tasks' chats sit under a "Closed task chats" filter in the app, still writable; a message there does not reopen the task.
5. **Open reminders are converted to tasks** by a one-off script (`--dry-run` default, `--apply` by the owner). The reminders API stays mounted for old app builds and the ERP Space+R box until those move.

## Global Constraints

- Title ≤ 120 chars, description ≤ 2,000 chars; priority `urgent | high | normal`; due date required on create and never in the past; default due time **18:00 in the assignee's time zone**.
- Statuses (exact ids): `assigned`, `date_change_requested`, `accepted`, `in_progress`, `waiting`, `done`, `closed`, `reopened`, `cancelled`. Overdue is a derived flag, never a status: open (not `done`/`closed`/`cancelled`) and `dueAt < now`.
- Comment required for `date_change_requested`, `waiting`, `reopened`, `cancelled`.
- Tasks are never deleted (no DELETE route).
- Quiet hours 22:00–07:00 recipient-local: no push unless the task is `urgent`; email always goes.
- Task-chat push: at most one per chat per user per 5 minutes (mentions bypass).
- Time zone of a user = their first branch's zone: NBO `Africa/Nairobi`, DAR `Africa/Dar_es_Salaam`, FBM `Africa/Lubumbashi`, everything else `Asia/Kolkata` (reuse `branchAutoClose(branch).tz` from `attendance.service.ts`).
- Working hours for the 4-hour nudge: Mon–Sat 10:00–19:00 recipient-local.
- Email = SMTP via nodemailer, same env as the ERP (`SMTP_HOST/PORT/SECURE/USER/PASS`, `MAIL_FROM`); dormant (logged, not sent) when `SMTP_HOST` is empty.
- Backend tests run with `npx jest --maxWorkers=1`; app tests with `npx jest --maxWorkers=1 --workerIdleMemoryLimit=1G`.
- No commits/pushes until the user says so; work stays in the `feat/smart-connect-tasks` worktrees.

## Review Focus

- A converted reminder with **no due date** (`dueAt: null`) must list, sort last, never be overdue and never alert. → Task 1 test `converted task without dueAt is never overdue`.
- **Reassigning** to the assigner themself turns it into a self task (status `accepted`), and the old assignee leaves the chat unless a watcher. → Task 3 test `reassign to self`.
- **Due date edited after alerts fired** must re-arm due/overdue alerts. → Task 3 test `editing dueAt clears alert stamps`.
- **Self task** (assigner = assignee): `done` lands as `closed`; no "assigner" push to oneself. → Task 1 + Task 4 tests.
- **Hierarchy viewer** posting into a task chat without joining → 403 (membership check), reading via `/tasks/:id/messages` → 200. → Task 3 test.

---

## Backend — `Mobile App/kb360-rn/Backend` (worktree `scratchpad/be`)

### Task 1: Pure rules and time helpers

**Files:**
- Create: `src/mongo/tasks/task.types.ts`, `src/mongo/tasks/task.rules.ts`, `src/mongo/tasks/task.time.ts`
- Test: `src/mongo/tasks/__tests__/taskRules.test.ts`, `src/mongo/tasks/__tests__/taskTime.test.ts`

**Interfaces (produces):**
- `type TaskStatus` (ids above); `type TaskPriority = 'urgent'|'high'|'normal'`; `type RepeatRule = { kind: 'none' } | { kind: 'daily' } | { kind: 'weekly'; days: number[] /*0=Sun*/ } | { kind: 'monthly'; dayOfMonth: number /*1–31, clamps to month end*/ }`
- `OPEN_STATUSES: TaskStatus[]` = assigned, date_change_requested, accepted, in_progress, waiting, reopened
- `isOverdue(t: {status; dueAt: Date|null}, now: Date): boolean`
- `allowedTransitions(t: {status; assignedBy; assignedTo}, actorId: string): TaskStatus[]`
- `planTransition(t, actorId, to, input: {comment?: string; dueAt?: Date|null}, now: Date): { status: TaskStatus; set: Record<string, unknown> }` — throws `BadRequest`/`Forbidden` (from `common/errors`). Sets the timestamp (`acceptedAt`, `doneAt`, `closedAt`, `cancelledAt`), `requestedDueAt` on a date request, `waitingOn` = comment on `waiting`; approving a date change sets `dueAt` (input or `requestedDueAt`) and clears alert stamps.
- `task.time.ts`: `tzForBranchCode(code?: string|null): string`; `zonedDateTime(dayKey: 'YYYY-MM-DD', hhmm: string, tz: string): Date`; `localParts(at: Date, tz): {dayKey; hour; minute; weekday}`; `inQuietHours(at, tz): boolean`; `workingMsBetween(from: Date, to: Date, tz): number`; `nextOccurrence(prevDue: Date, rule: RepeatRule, tz): Date|null`

Transition table (assignee = A, assigner = B; self task = both):
assigned→accepted(A), assigned→date_change_requested(A), date_change_requested→accepted(B), accepted→in_progress(A), in_progress→waiting(A), in_progress→done(A), waiting→in_progress(A), waiting→done(A), reopened→in_progress(A), done→closed(B), done→reopened(B), closed→reopened(B), every OPEN status→cancelled(B). Self task only: accepted→done and reopened→done also allowed, and any →done resolves to `closed`.

- [ ] Write tests: each row of the table allowed for the right actor and refused (`Forbidden`) for the other; `cancelled` without comment → `BadRequest /reason/`; `date_change_requested` without `dueAt` → `BadRequest`; self task `in_progress→done` returns status `closed` with both `doneAt` and `closedAt`; `converted task without dueAt is never overdue`; `done` is not overdue. Time: `zonedDateTime('2026-11-18','18:00','Asia/Kolkata').toISOString() === '2026-11-18T12:30:00.000Z'`; `inQuietHours(22:30 IST)` true, `07:00` false; `workingMsBetween` Sat 18:00 → Mon 11:00 IST = 2 h; Sunday contributes 0; `nextOccurrence` weekly `[1,4]` from Mon 18:00 → Thu 18:00; monthly 31 from Jan 31 → Feb 28/29.
- [ ] Run `npx jest src/mongo/tasks --maxWorkers=1` → FAIL (modules missing).
- [ ] Implement with `Intl.DateTimeFormat` (no new dependency).
- [ ] Run again → PASS.

### Task 2: Models, repository, mailer, notifier

**Files:**
- Create: `src/mongo/tasks/task.model.ts` (`TaskModel`, `TaskHistoryModel`, `TaskNotificationModel`, `TaskDigestModel`, `ensureTaskIndexes()`), `src/mongo/tasks/task.repository.ts`, `src/mailer.ts`, `src/mongo/tasks/task.notify.ts`
- Modify: `src/mongo/chat/chat.models.ts` (conversation `type` enum + `'task'`, add `taskId: string|null`), `package.json` (+ `nodemailer`, `@types/nodemailer`), `src/mongo/main.ts` (call `ensureTaskIndexes()`)
- Test: `src/mongo/tasks/__tests__/taskNotify.test.ts`

**Interfaces (produces):**
- `TaskDoc` fields: `title, description, companyId|null, branchId, assignedTo, assignedBy, watchers[{userId, addedBy, addedAt}], priority, dueAt|null, status, requestedDueAt|null, waitingOn|null, attachments[{url,name,size,mime,uploadedBy,uploadedAt}], repeat, parentRecurringId|null, nextSpawnedAt|null, chatId|null, link{label,url}|null, source 'app'|'erp'|'reminder', legacyReminderId|null, assignedAt, acceptedAt, doneAt, closedAt, cancelledAt, alerts{dueTomorrowAt, due2hAt, overdueAt, acceptNudgeAt}, createdAt, updatedAt`
- `TaskHistoryDoc`: `taskId, userId, field, oldValue|null, newValue|null, comment|null, createdAt` (`field` ∈ created, status, title, description, dueAt, priority, branchId, assignedTo, watchers, attachment, repeat, link)
- `TaskNotificationDoc` (= spec's notification_log + in-app list): `userId, taskId, event, title, body, channels: ('push'|'email'|'inapp')[], sentAt, openedAt|null`
- `mailer.send({to, subject, text, html?}): Promise<boolean>` — false when dormant
- `taskNotify.send(event: TaskEvent, task: TaskDoc, recipients: string[], ctx: {actorId?: string; comment?: string; urgentPush?: boolean}): Promise<void>` — drops the actor, de-dupes, writes one `TaskNotification` per recipient, push (Expo, via `callDeviceRepo.tokensForUser`, `data: {type:'task', taskId, chatId}`, `channelId:'general'`) unless quiet hours and not urgent, email via `mailer`.
- `TaskEvent` = assigned | reassigned | reassigned_away | accepted | date_change_requested | waiting | done | closed | reopened | cancelled | due_changed | priority_changed | accept_nudge | due_tomorrow | due_2h | overdue | mention

- [ ] Write tests (mock `callDeviceRepo`, `crmRepo`, `mailer`, models): actor never notified; quiet-hours push suppressed for `normal` but sent for `urgent`; email sent even in quiet hours; dormant mailer returns false without throwing.
- [ ] Run → FAIL; implement; run → PASS.

### Task 3: Task service + chat integration

**Files:**
- Create: `src/mongo/tasks/task.service.ts`, `src/mongo/tasks/task.dto.ts`
- Modify: `src/mongo/chat/chat.service.ts` — export `chatService.createTaskChat(actorId, {taskId, title, memberIds, companyId, branchId})`, `chatService.setTaskChatMembers(convId, memberIds, actorId)`, `chatService.renameTaskChat(convId, title)`, `chatService.postTaskNotice(convId, actorId, text)` (wraps the private `postSystemMessage`), `chatService.readTaskMessages(convId, page)`; `buildConvDTO` returns `taskId` for task chats; group-management methods keep refusing non-`group` types.
- Test: `src/mongo/tasks/__tests__/taskService.test.ts`

**Interfaces (produces):** `tasksService` with
`create(actorId, input)`, `list(actorId, {view: 'mine'|'assigned'|'watching'|'team', state: 'open'|'closed'|'all', status?, priority?, branchId?, companyId?, personId?, dueFrom?, dueTo?, q?})`, `get(actorId, id)` → `{task, history}`, `changeStatus(actorId, id, {to, comment?, dueAt?})`, `reassign(actorId, id, {assignedTo, comment?})`, `patch(actorId, id, fields)`, `watchers(actorId, id, {add?, remove?})`, `addAttachment(actorId, id, att)`, `messages(actorId, id, page)`, `dashboard(actorId, {companyId?, branchId?})`, `notifications(actorId)`, `canView(access, task)`.
`TaskDTO` (exact keys, consumed by the app): `id, title, description, companyId, companyName, branchId, branchName, assignedTo{id,name}, assignedBy{id,name}, watchers[{id,name}], priority, dueAt(ISO|null), status, requestedDueAt, waitingOn, attachments, repeat, link, chatId, unread, overdue, isSelf, myRole('assigner'|'assignee'|'both'|'watcher'|'viewer'), actions(TaskStatus[]), canEdit, canReassign, source, createdAt, acceptedAt, doneAt, closedAt, cancelledAt`.

Behaviour: create resolves `dueDate`+`dueTime` (default `18:00`) in the assignee's zone, refuses past due, writes history `created`, creates the chat (assigner, assignee, watchers), posts "<name> created this task · due <date>", notifies `assigned`. Every status change / edit / reassign / watcher / attachment writes history and posts a chat notice ("Satish marked this Done – to close", "Task closed by Afshin Dhanani on 20 Nov 2026", reason appended for cancel/reopen/waiting/date request). Edit is assigner-only; `dueAt`/`dueDate` change clears `alerts.*` and notifies `due_changed`; title change renames the chat. Reassign is assigner-only, open tasks only, resets to `assigned` (or `accepted` if the new assignee is the assigner), clears alerts, swaps chat membership. Closing a recurring task spawns the next copy (Task 4's `spawnNext`).

- [ ] Write tests (mock repo/chat/notify/crm/access): visibility (assigner/assignee/watcher yes; hierarchy viewer yes with `myRole:'viewer'` and `actions: []`; unrelated staff → `NotFound`); `reassign to self`; `editing dueAt clears alert stamps`; non-assigner PATCH → `Forbidden`; status change posts a chat notice and history row; hierarchy viewer `messages()` allowed; past due on create → `BadRequest`.
- [ ] Run → FAIL; implement; run → PASS.

### Task 4: Router, sweep, recurring, digest, chat throttle

**Files:**
- Create: `src/mongo/tasks/tasks.router.ts`, `src/mongo/tasks/task.sweep.ts`
- Modify: `src/mongo/app.ts` (mount `app.use('/api/tasks', tasksRouter)` after chatRouter), `src/mongo/main.ts` (start/stop sweep), `src/mongo/chat/chat.service.ts` (`sendMessage`: for `type==='task'` skip push to a recipient pushed for the same chat < 5 min ago unless mentioned; record mention as `taskNotify` `mention` with email)
- Test: `src/mongo/tasks/__tests__/taskSweep.test.ts`, `src/mongo/tasks/__tests__/tasksRouter.test.ts` (supertest, service mocked)

**Routes:** `POST /api/tasks`, `GET /api/tasks?view=&state=&…`, `GET /api/tasks/dashboard`, `GET /api/tasks/notifications`, `GET /api/tasks/:id`, `PATCH /api/tasks/:id`, `POST /api/tasks/:id/status`, `POST /api/tasks/:id/reassign`, `POST /api/tasks/:id/watchers`, `POST /api/tasks/:id/attachments`, `GET /api/tasks/:id/messages`. zod bodies enforce the Global Constraints lengths and enums. No DELETE.

Sweep (every 60 s; each alert claimed with an atomic `findOneAndUpdate` on its `alerts.*At: null`): `due_tomorrow` when `dueAt-now ≤ 24h`, `>2h`, task older than 1 h; `due_2h` when `0 < dueAt-now ≤ 2h`, task older than 30 min (urgent → high-priority push even in quiet hours); `overdue` when `dueAt ≤ now` and open → assignee + assigner; `accept_nudge` when `status:'assigned'` and `workingMsBetween(assignedAt, now) ≥ 4h`; recurring `spawnNext` when a recurring task is `closed`, or still open and `now ≥` local midnight of its next occurrence (claimed via `nextSpawnedAt`); digest at local 08:00–08:59 once per user per day (claimed in `task_digests` unique `{userId, dayKey}`), email only.

- [ ] Write tests: each sweep rule fires once and not twice; cancelled recurring task spawns nothing; router rejects title of 121 chars (400) and has no DELETE (404).
- [ ] Run → FAIL; implement; run → PASS; `npm run typecheck` clean; full `npx jest --maxWorkers=1` no new failures vs `origin/main`.

### Task 5: Reminder conversion script

**Files:** Create `scripts/convert-reminders-to-tasks.ts`.

Reads `reminders` with `state ∈ {pending, review}`; per doc builds a task: title = first 120 chars of `text` (full text → description when longer), `assignedTo=forId`, `assignedBy=byId`, `dueAt` kept (may be null), branch = assignee's first branch, status `accepted` (pending) / `done` (review — the creator still checks it), self → `accepted`, `source:'reminder'`, `legacyReminderId`, all `alerts.*` stamped `now` when already past due (no push storm), chat created, image → attachment. Skips reminders that already have a task (`legacyReminderId`). `--dry-run` (default) prints counts per user; `--apply` writes and sets the reminder `state:'approved'`, `approvedAt`. Asserts the DB name is `kb360_app` before writing.

- [ ] Run against local/staging with `--dry-run`; owner runs `--apply` after deploy.

## App — `Mobile App/kb360-rn/Frontend` (worktree `scratchpad/fe`)

### Task 6: API client, store, pure grouping logic

**Files:** Create `src/api/tasks.ts`, `src/store/tasksStore.ts` (or the repo's store pattern), `src/logic/taskGroups.ts`, `src/logic/taskRules.ts` (status labels, colours, required-comment set), tests in `src/__tests__/`.

`groupMine(tasks, now)` → sections Overdue, Due today, This week, Later, Done – waiting to close (status `done`). `groupAssigned` = same + "Waiting for my check" (status `done`, first). Labels: Assigned, Date change requested, Accepted, In progress, Waiting on someone, Done – to close, Closed, Reopened, Cancelled.

### Task 7: Screens

- Tasks tab replaces Reminders (`app/(tabs)/reminders.tsx` → Tasks; tab title "Tasks"): segments My tasks / Assigned by me / Watching (+ Team for managers), row = title, other party, business, due, priority pill, status pill, red overdue flag, unread chat badge; filters person / branch / priority / status / due range; search by title; "New task" button.
- `app/task/new.tsx` (create/edit form: title, description, Assign to = person picker with "Myself" first, watchers, business/branch, priority, due date + time default 6 pm, repeat, attachments).
- `app/task/[id].tsx` detail: fields, status buttons from `actions` (comment sheet; required for the four statuses; date picker for date change), attachments, history, Open chat (unread count), Edit/Reassign for assigner, Watch/Unwatch.
- `app/task/dashboard.tsx`: counts, by-person, by-branch tables; tapping a number opens the filtered list.
- Chat: `app/chat/[id].tsx` shows a pinned task card for `type==='task'` (title, business, due, priority, status, Open task) with quick actions from `actions`; chat list gets "Task chats" and "Closed task chats" filters; tapping a `type:'task'` push opens the task chat.
- Old reminder routes stay reachable only from nowhere (removed from tabs/home); widget/ERP follow-ups listed below.

- [ ] typecheck + jest green; screenshots on the emulator; owner's phone via OTA only after the owner says so (see memory: NEXT OTA BASE rules).

## Follow-ups (not in this pass)

- ERP Space+R box creates tasks instead of reminders (ERP BE + Books).
- Work Board widget reads tasks (native Swift/Kotlin → needs store builds).
- Web client (`kb360-rn/Web`) Tasks menu.
- Offline: chat already queues; task actions need network (spec acceptance "offline messages are sent once back online" is met by chat's existing queue).
