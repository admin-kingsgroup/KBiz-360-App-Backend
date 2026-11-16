/* eslint-disable no-console */
// End-to-end check of Smart Connect Tasks against a LOCAL mongod, in two throwaway databases that are
// created and dropped by this script (never the CRM or kb360_app). Drives the real Express app over
// HTTP (supertest) and the real sweep. Run:
//   E2E_MONGO=mongodb://127.0.0.1:27017 npx ts-node scripts/tasks-e2e.ts
/* eslint-disable @typescript-eslint/no-explicit-any */
import { MongoClient, ObjectId } from 'mongodb';

const MONGO = process.env.E2E_MONGO ?? 'mongodb://127.0.0.1:27017';
const SUFFIX = `${Date.now()}`;
const CRM_DB = `kb360_tasks_e2e_crm_${SUFFIX}`;
const APP_DB = `kb360_tasks_e2e_app_${SUFFIX}`;
if (!/^mongodb:\/\/(127\.0\.0\.1|localhost)/.test(MONGO)) { console.error('Refusing: E2E_MONGO must be a local mongod'); process.exit(2); }
process.env.MONGODB_URI = MONGO;
process.env.CRM_DB = CRM_DB;
process.env.APP_DB = APP_DB;
process.env.JWT_ACCESS_SECRET = 'e2e-access-secret-0123456789-0123456789-0123456789';
process.env.JWT_REFRESH_SECRET = 'e2e-refresh-secret-0123456789-0123456789-0123456789';
process.env.EXPO_PUSH_ENABLED = 'false';
process.env.SMTP_HOST = '';

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, extra: unknown = ''): void => {
  if (ok) { pass += 1; console.log(`  ✓ ${label}`); } else { fail += 1; console.log(`  ✗ ${label} ${extra ? JSON.stringify(extra).slice(0, 400) : ''}`); }
};

async function main(): Promise<void> {
  const raw = new MongoClient(MONGO);
  await raw.connect();
  const crm = raw.db(CRM_DB);
  // ── seed the throwaway CRM: 1 company, BOM + NBO, roles, 5 people ──
  const tenant = new ObjectId();
  const company = new ObjectId();
  const bom = new ObjectId();
  const nbo = new ObjectId();
  await crm.collection('companies').insertOne({ _id: company, tenant_id: tenant, name: 'Travkings' });
  await crm.collection('branches').insertMany([
    { _id: bom, tenant_id: tenant, company_id: company, name: 'Mumbai', code: 'BOM' },
    { _id: nbo, tenant_id: tenant, company_id: company, name: 'Nairobi', code: 'NBO' },
  ]);
  const roles = { super: new ObjectId(), bm: new ObjectId(), emp: new ObjectId() };
  await crm.collection('roles').insertMany([
    { _id: roles.super, tenant_id: tenant, name: 'super_admin', level: 1, permissions: ['*'] },
    { _id: roles.bm, tenant_id: tenant, name: 'branch_manager', level: 3, permissions: [] },
    { _id: roles.emp, tenant_id: tenant, name: 'employee', level: 5, permissions: [] },
  ]);
  const mk = (first: string, role: ObjectId, branch: ObjectId) => ({
    _id: new ObjectId(), tenant_id: tenant, role_id: role, email: `${first.toLowerCase()}@e2e.test`, first_name: first, last_name: 'E2E',
    status: 'active', branch_ids: [branch], access: { app: true, crm: true, erp: true },
  });
  const owner = mk('Owner', roles.super, bom);
  const mgr = mk('Manager', roles.bm, bom);
  const satish = mk('Satish', roles.emp, bom);
  const faiz = mk('Faiz', roles.emp, bom);
  const wanjiru = mk('Wanjiru', roles.emp, nbo);
  await crm.collection('users').insertMany([owner, mgr, satish, faiz, wanjiru]);
  const id = (u: { _id: ObjectId }): string => String(u._id);

  const { connectMongo, disconnectMongo } = await import('../src/mongo/connection');
  const { createMongoApp } = await import('../src/mongo/app');
  const { signAccess } = await import('../src/modules/auth/jwt');
  const { ensureTaskIndexes, TaskModel } = await import('../src/mongo/tasks/task.model');
  const { ensureChatIndexes } = await import('../src/mongo/chat/chat.models');
  const { runTaskSweep } = await import('../src/mongo/tasks/task.sweep');
  const request = (await import('supertest')).default;
  await connectMongo();
  await ensureTaskIndexes();
  await ensureChatIndexes();
  const app = createMongoApp();
  const tok = (u: { _id: ObjectId }): string => `Bearer ${signAccess(id(u), 'employee')}`;
  const as = (u: { _id: ObjectId }) => ({
    get: (p: string) => request(app).get(p).set('Authorization', tok(u)),
    post: (p: string, b?: unknown) => request(app).post(p).set('Authorization', tok(u)).send(b as object),
    patch: (p: string, b?: unknown) => request(app).patch(p).set('Authorization', tok(u)).send(b as object),
    del: (p: string) => request(app).delete(p).set('Authorization', tok(u)),
  });

  try {
    const tomorrow = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
    console.log('\nCreate + lists + visibility');
    const c = await as(owner).post('/api/tasks', { title: 'E2E: close October books', assignedTo: id(satish), branchId: String(bom), priority: 'high', dueDate: tomorrow, watcherIds: [id(faiz)] });
    check('create → 201 Assigned, 6 pm IST', c.status === 201 && c.body.status === 'assigned' && c.body.dueAt === new Date(`${tomorrow}T12:30:00.000Z`).toISOString(), c.body);
    const taskId = c.body.id as string;
    const chatId = c.body.chatId as string;
    check('task has a chat', !!chatId);
    const mine = await as(satish).get('/api/tasks?view=mine');
    check('Satish: My tasks has it', mine.status === 200 && mine.body.some((t: any) => t.id === taskId), mine.body);
    const given = await as(owner).get('/api/tasks?view=assigned');
    check('Owner: Assigned by me has it', given.body.some((t: any) => t.id === taskId));
    const watching = await as(faiz).get('/api/tasks?view=watching');
    check('Faiz: Watching has it', watching.body.some((t: any) => t.id === taskId));
    const team = await as(mgr).get('/api/tasks?view=team');
    check('Manager (BOM, level 3): Team has it', team.body.some((t: any) => t.id === taskId), team.body);
    const nboView = await as(wanjiru).get(`/api/tasks/${taskId}`);
    check('Nairobi staff cannot open it (404)', nboView.status === 404);
    const convs = await as(satish).get('/api/conversations');
    const conv = (convs.body as any[]).find((x) => x.id === chatId);
    check('chat list: type task + taskId + named after the task', conv?.type === 'task' && conv?.taskId === taskId && conv?.name === 'E2E: close October books', conv);

    console.log('\nStatus machine over HTTP');
    check('Assigned → Closed is not a move (400)', (await as(satish).post(`/api/tasks/${taskId}/status`, { to: 'closed' })).status === 400);
    check('assigned → accepted', (await as(satish).post(`/api/tasks/${taskId}/status`, { to: 'accepted' })).body.status === 'accepted');
    check('accepted → in_progress', (await as(satish).post(`/api/tasks/${taskId}/status`, { to: 'in_progress' })).body.status === 'in_progress');
    const waitNoReason = await as(satish).post(`/api/tasks/${taskId}/status`, { to: 'waiting' });
    check('waiting without a reason → 400', waitNoReason.status === 400, waitNoReason.body);
    check('in_progress → done', (await as(satish).post(`/api/tasks/${taskId}/status`, { to: 'done' })).body.status === 'done');
    const satClose = await as(satish).post(`/api/tasks/${taskId}/status`, { to: 'closed' });
    check('assignee cannot close their own task (403)', satClose.status === 403, satClose.body);
    const dash1 = await as(owner).get('/api/tasks/dashboard');
    const check1 = await as(owner).get('/api/tasks?view=all&flag=waiting_check');
    check('dashboard "waiting for my check" = its list', dash1.body.counts.waitingForMyCheck === check1.body.length && check1.body.length >= 1, dash1.body);
    const closed = await as(owner).post(`/api/tasks/${taskId}/status`, { to: 'closed' });
    check('assigner closes → Closed', closed.body.status === 'closed', closed.body);
    const convAfter = ((await as(satish).get('/api/conversations')).body as any[]).find((x) => x.id === chatId);
    check('chat list row carries taskStatus = closed', convAfter?.taskStatus === 'closed', convAfter);
    check('old-app "Block" on a task chat (empty id) → 400', (await as(satish).post('/api/chat/block/undefined')).status === 400);

    console.log('\nTask chat (always open) + read-only for a manager');
    const msgs = await as(satish).get(`/api/conversations/${chatId}/messages`);
    const texts = (msgs.body as any[]).filter((m) => m.type === 'system').map((m) => m.text);
    check('system lines for every change', texts.some((t: string) => t.startsWith('Owner E2E assigned this task to Satish E2E')) && texts.some((t: string) => t.startsWith('Satish E2E marked this Done – to close')) && texts.some((t: string) => t.startsWith('Task closed by Owner E2E on')), texts);
    const after = await as(satish).post('/api/messages', { conversationId: chatId, text: 'Thanks — books are closed', type: 'text' });
    check('closed task chat still takes messages (always open)', after.status === 201, after.body);
    const mgrRead = await as(mgr).get(`/api/tasks/${taskId}/messages`);
    check('manager reads the chat via the task', mgrRead.status === 200 && (mgrRead.body as any[]).length >= 3);
    const mgrPost = await as(mgr).post('/api/messages', { conversationId: chatId, text: 'hello', type: 'text' });
    check('manager cannot post without joining (403)', mgrPost.status === 403, mgrPost.body);
    const hist = await as(owner).get(`/api/tasks/${taskId}`);
    check('history has created + 4 status rows', hist.body.history.filter((h: any) => h.field === 'status').length === 4 && hist.body.history[0].field === 'created', hist.body.history);

    console.log('\nInput guards');
    check('121-char title → 400', (await as(owner).post('/api/tasks', { title: 'x'.repeat(121), assignedTo: id(satish), branchId: String(bom), priority: 'normal', dueDate: tomorrow })).status === 400);
    check('past due → 400', (await as(owner).post('/api/tasks', { title: 'past', assignedTo: id(satish), branchId: String(bom), priority: 'normal', dueDate: '2020-01-01' })).status === 400);
    check('no DELETE route (404)', (await as(owner).del(`/api/tasks/${taskId}`)).status === 404);
    check('task chat cannot be deleted', (await as(satish).del(`/api/conversations/${chatId}`)).status >= 400);

    console.log('\nSweep: alerts fire once');
    const t2 = await as(owner).post('/api/tasks', { title: 'E2E: due soon', assignedTo: id(satish), branchId: String(bom), priority: 'urgent', dueDate: tomorrow });
    const now = new Date();
    // raw collection: Mongoose strips the immutable createdAt from a model update
    await TaskModel().collection.updateOne({ _id: new ObjectId(t2.body.id) }, { $set: { dueAt: new Date(now.getTime() + 60 * 60_000), createdAt: new Date(now.getTime() - 3 * 3_600_000), assignedAt: new Date(now.getTime() - 3 * 86_400_000) } });
    const s1 = await runTaskSweep(now);
    const s2 = await runTaskSweep(now);
    check('due in 2 h fired once', s1.due2h >= 1 && s2.due2h === 0, { s1, s2 });
    check('not-accepted nudge fired once (3 days in Assigned)', s1.acceptNudge >= 1 && s2.acceptNudge === 0, { s1, s2 });
    await TaskModel().updateOne({ _id: new ObjectId(t2.body.id) }, { $set: { dueAt: new Date(now.getTime() - 60_000) } });
    const s3 = await runTaskSweep(now);
    const s4 = await runTaskSweep(now);
    check('overdue fired once', s3.overdue >= 1 && s4.overdue === 0, { s3, s4 });
    const overdueList = await as(satish).get('/api/tasks?view=mine&flag=overdue');
    check('overdue flag in the list', overdueList.body.some((t: any) => t.id === t2.body.id && t.overdue === true));
    const inbox = await as(satish).get('/api/tasks/notifications');
    check('in-app list has the alerts', (inbox.body as any[]).some((n) => n.event === 'overdue') && (inbox.body as any[]).some((n) => n.event === 'due_2h'), inbox.body);

    console.log('\nRepeat');
    const r = await as(owner).post('/api/tasks', { title: 'E2E: weekly MIS', assignedTo: id(owner), branchId: String(bom), priority: 'normal', dueDate: tomorrow, repeat: { kind: 'weekly', days: [1, 4] } });
    check('self task starts Accepted', r.body.status === 'accepted', r.body);
    const rd = await as(owner).post(`/api/tasks/${r.body.id}/status`, { to: 'done' });
    check('self task: Done closes it', rd.body.status === 'closed', rd.body);
    const copies = await TaskModel().find({ parentRecurringId: r.body.id }).lean();
    check('closing spawned exactly one next copy', copies.length === 1 && copies[0].dueAt!.getTime() > Date.parse(r.body.dueAt), copies.map((x) => x.dueAt));

    console.log('\nConvert open reminders (script, --apply on the throwaway DB)');
    const appRaw = raw.db(APP_DB);
    const longText = `E2E reminder: ${'reconcile the HDFC statement '.repeat(6)}`;
    await appRaw.collection('reminders').insertMany([
      { text: 'E2E reminder: call Rezlive', forId: id(satish), byId: id(owner), state: 'pending', dueAt: new Date(Date.now() - 86_400_000), createdAt: new Date(), updatedAt: new Date() },
      { text: longText, forId: id(satish), byId: id(owner), state: 'review', dueAt: null, completedAt: new Date(), createdAt: new Date(), updatedAt: new Date() },
      { text: 'E2E reminder: already done', forId: id(satish), byId: id(owner), state: 'approved', dueAt: null, createdAt: new Date(), updatedAt: new Date() },
    ]);
    const { execFileSync } = await import('child_process');
    const runConvert = (): string => execFileSync('npx', ['ts-node', '--transpile-only', 'src/mongo/tasks/convertReminders.cli.ts', '--apply', '--allow-db'], { env: { ...process.env }, encoding: 'utf8' });
    const out1 = runConvert();
    const conv1 = await TaskModel().find({ source: 'reminder' }).lean();
    check('2 open reminders → 2 tasks (approved one left alone)', conv1.length === 2, out1);
    const pending = conv1.find((t) => t.title === 'E2E reminder: call Rezlive');
    const review = conv1.find((t) => t.title !== 'E2E reminder: call Rezlive');
    check('pending → Accepted, past due, alerts pre-stamped (no push burst)', pending?.status === 'accepted' && !!pending?.alerts.overdueAt, pending);
    check('review → Done – to close; long text → 120-char title + full description', review?.status === 'done' && (review?.title.length ?? 0) <= 120 && review?.description === longText.trim(), review);
    const rems = await appRaw.collection('reminders').find({ convertedToTaskId: { $exists: true } }).toArray();
    check('reminders archived with convertedToTaskId', rems.length === 2 && rems.every((x) => x.state === 'approved'));
    runConvert();
    check('second run converts nothing (idempotent)', (await TaskModel().countDocuments({ source: 'reminder' })) === 2);
    const pid = String(pending?._id);
    const lst = await as(satish).get('/api/tasks?view=mine');
    check('converted tasks list without a chat; undated sorts last', lst.body.some((t: any) => t.id === pid && t.chatId === null) && lst.body[lst.body.length - 1].dueAt === null, lst.body.map((t: any) => [t.title, t.dueAt]));
    const e1 = await as(satish).post(`/api/tasks/${pid}/chat`);
    const e2 = await as(owner).post(`/api/tasks/${pid}/chat`);
    check('first open creates the chat; the next returns the same one', e1.status === 200 && !!e1.body.chatId && e2.body.chatId === e1.body.chatId, [e1.body, e2.body]);
  } finally {
    await disconnectMongo();
    for (const name of [CRM_DB, APP_DB]) {
      if (!name.startsWith('kb360_tasks_e2e_')) throw new Error(`refusing to drop ${name}`);
      await raw.db(name).dropDatabase();
    }
    await raw.close();
  }
  console.log(`\n${pass} passed, ${fail} failed (throwaway DBs dropped)`);
  process.exit(fail ? 1 : 0);
}

void main().catch((e) => { console.error(e); process.exit(1); });
