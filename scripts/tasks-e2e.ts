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
process.env.ALERTS_INGEST_TOKEN = 'e2e-service-token-0123456789';
process.env.STORAGE_DRIVER = 'local';
process.env.STORAGE_LOCAL_DIR = `/tmp/kb360-tasks-e2e-uploads-${SUFFIX}`;

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
  // The three who watch every Operations task (task.autoWatchers) — found by their real login emails.
  const harshit = { ...mk('Harshit', roles.emp, bom), email: 'harshit@travkings.com' };
  const asif = { ...mk('Asif', roles.emp, bom), email: 'asif@travkings.com' };
  const farhan = { ...mk('Farhan', roles.bm, bom), email: 'farhan@travkings.com' };
  await crm.collection('users').insertMany([owner, mgr, satish, faiz, wanjiru, harshit, asif, farhan]);
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
    check('a new task has NO chat yet', c.body.chatId === null, c.body);
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

    console.log('\nStart chat (giver, assignee or a watcher — owner 2026-11-18)');
    check('a manager who is not on the task cannot start the chat (403)', (await as(mgr).post(`/api/tasks/${taskId}/chat`)).status === 403);
    const started = await as(faiz).post(`/api/tasks/${taskId}/chat`);
    const chatId = started.body.chatId as string;
    check('a watcher starts it', started.status === 200 && !!chatId, started.body);
    check('the assignee then gets the same chat', (await as(satish).post(`/api/tasks/${taskId}/chat`)).body.chatId === chatId);
    check('the giver then gets the same chat', (await as(owner).post(`/api/tasks/${taskId}/chat`)).body.chatId === chatId);
    check('the watcher has it on their chat list', ((await as(faiz).get('/api/conversations')).body as any[]).some((x) => x.id === chatId));
    const watcherMsg = await as(faiz).post('/api/messages', { conversationId: chatId, text: 'Watching — tell me if you need the bank statement', type: 'text' });
    check('the watcher writes in it (201)', watcherMsg.status === 201, watcherMsg.body);
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
    check('closed: the chat is off the chat list', !convAfter, convAfter);
    check('old-app "Block" on a task chat (empty id) → 400', (await as(satish).post('/api/chat/block/undefined')).status === 400);

    console.log('\nClosed task chat: read-only, readable from the task, back on reopen');
    const msgs = await as(satish).get(`/api/tasks/${taskId}/messages`);
    const texts = (msgs.body as any[]).filter((m) => m.type === 'system').map((m) => m.text);
    check('system lines for every change since the chat started', texts.some((t: string) => t.startsWith('Faiz E2E started a chat about this task')) && texts.some((t: string) => t.startsWith('Satish E2E marked this Done – to close')) && texts.some((t: string) => t.startsWith('Task closed by Owner E2E on')), texts);
    const after = await as(satish).post('/api/messages', { conversationId: chatId, text: 'Thanks — books are closed', type: 'text' });
    check('closed task chat refuses messages (423)', after.status === 423, after.body);
    check('closed task: Start chat just returns the existing read-only chat', (await as(owner).post(`/api/tasks/${taskId}/chat`)).body.chatId === chatId);
    const reo = await as(owner).post(`/api/tasks/${taskId}/status`, { to: 'reopened', comment: 'Bank charges missing' });
    check('reopen → the chat is back on the list and takes messages', reo.body.status === 'reopened'
      && ((await as(satish).get('/api/conversations')).body as any[]).some((x) => x.id === chatId)
      && (await as(satish).post('/api/messages', { conversationId: chatId, text: 'On it', type: 'text' })).status === 201, reo.body);
    await as(satish).post(`/api/tasks/${taskId}/status`, { to: 'in_progress' });
    await as(satish).post(`/api/tasks/${taskId}/status`, { to: 'done' });
    await as(owner).post(`/api/tasks/${taskId}/status`, { to: 'closed' });
    const mgrRead = await as(mgr).get(`/api/tasks/${taskId}/messages`);
    check('manager reads the chat via the task', mgrRead.status === 200 && (mgrRead.body as any[]).length >= 3);
    const mgrPost = await as(mgr).post('/api/messages', { conversationId: chatId, text: 'hello', type: 'text' });
    check('manager cannot post without joining (403)', mgrPost.status === 403, mgrPost.body);
    const hist = await as(owner).get(`/api/tasks/${taskId}`);
    check('history has created + 8 status rows', hist.body.history.filter((h: any) => h.field === 'status').length === 8 && hist.body.history[0].field === 'created', hist.body.history.map((h: any) => h.newValue));

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

    console.log('\nERP right-click → task (service door, as the ERP user)');
    const svc = (u: { _id: ObjectId } | null) => ({
      get: (p: string) => { const r = request(app).get(`/api/service/tasks${p}`).set('Authorization', 'Bearer e2e-service-token-0123456789'); return u ? r.set('X-Act-As', id(u)) : r; },
      post: (p: string, b: unknown) => { const r = request(app).post(`/api/service/tasks${p}`).set('Authorization', 'Bearer e2e-service-token-0123456789'); return (u ? r.set('X-Act-As', id(u)) : r).send(b as object); },
    });
    check('no service token → 401', (await request(app).get('/api/service/tasks/people').set('X-Act-As', id(mgr))).status === 401);
    check('no X-Act-As → 400', (await svc(null).get('/people')).status === 400);
    const ppl = await svc(mgr).get('/people');
    check('people list for the ERP user (company-wide)', ppl.status === 200 && (ppl.body as any[]).some((p) => p.id === id(owner)) && (ppl.body as any[]).every((p) => 'app' in p), ppl.body);
    const brs = await svc(mgr).get('/branches');
    check('branches with codes and the business name', brs.status === 200 && (brs.body as any[]).some((b) => b.code === 'BOM' && b.companyName === 'Travkings'), brs.body);
    const erpTask = await svc(mgr).post('', {
      title: 'E2E: HDFC charges missing', assignedTo: id(satish), branchId: String(bom), priority: 'high', dueDate: tomorrow,
      link: { label: 'Bank Reconciliation · BOM', url: 'https://kbizbooks-kings.duckdns.org/bank-reco?b=BOM' },
      image: { mime: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==' },
    });
    check('created as the ERP user, source erp, link + screenshot on the task, no chat yet', erpTask.status === 201 && erpTask.body.assignedBy.id === id(mgr)
      && erpTask.body.source === 'erp' && erpTask.body.link?.url?.startsWith('https://kbizbooks') && erpTask.body.attachments.length === 1 && erpTask.body.chatId === null, erpTask.body);
    check('it is in the assignee\'s My tasks', ((await as(satish).get('/api/tasks?view=mine')).body as any[]).some((t) => t.id === erpTask.body.id));
    check('a past due date is refused as the app refuses it', (await svc(mgr).post('', { title: 'x', assignedTo: id(satish), branchId: String(bom), priority: 'normal', dueDate: '2020-01-01' })).status === 400);
    check('a javascript: link is refused', (await svc(mgr).post('', { title: 'x', assignedTo: id(satish), branchId: String(bom), priority: 'normal', dueDate: tomorrow, link: { label: 'x', url: 'javascript:alert(1)' } })).status === 400);

    console.log('\nOperations tasks: Harshit, Asif and Farhan watch (owner 2026-11-20)');
    const watcherIds = (t: any): string[] => (t.watchers as any[]).map((w) => w.id);
    const opsBody = { assignedTo: id(satish), branchId: String(bom), priority: 'normal', dueDate: tomorrow, department: 'operations' };
    const ops = await as(owner).post('/api/tasks', { ...opsBody, title: 'E2E: visa file for the Dubai group' });
    check('an Operations task gets the three as watchers', ops.status === 201 && JSON.stringify(watcherIds(ops.body)) === JSON.stringify([id(harshit), id(asif), id(farhan)]), ops.body);
    check('Harshit: Watching has it', ((await as(harshit).get('/api/tasks?view=watching')).body as any[]).some((t) => t.id === ops.body.id));
    const opsChat = await as(asif).post(`/api/tasks/${ops.body.id}/chat`);
    check('one of them starts its chat', opsChat.status === 200 && !!opsChat.body.chatId, opsChat.body);
    const byFarhan = await as(farhan).post('/api/tasks', { ...opsBody, assignedTo: id(harshit), title: 'E2E: hotel vouchers for Goa' });
    check('given by Farhan, for Harshit: only Asif is added', byFarhan.status === 201 && JSON.stringify(watcherIds(byFarhan.body)) === JSON.stringify([id(asif)]), byFarhan.body);
    const handed = await as(farhan).post(`/api/tasks/${byFarhan.body.id}/reassign`, { assignedTo: id(satish) });
    check('handed to someone else: Harshit goes back to watching', handed.status === 200 && JSON.stringify(watcherIds(handed.body)) === JSON.stringify([id(asif), id(harshit)]), handed.body);
    const acc = await as(owner).post('/api/tasks', { ...opsBody, department: 'accounts', title: 'E2E: GST challan' });
    check('an Accounts task gets nobody', acc.status === 201 && watcherIds(acc.body).length === 0, acc.body);
    const moved = await as(owner).patch(`/api/tasks/${acc.body.id}`, { department: 'operations' });
    check('moved into Operations: the three are added', moved.status === 200 && JSON.stringify(watcherIds(moved.body)) === JSON.stringify([id(harshit), id(asif), id(farhan)]), moved.body);
    const erpOps = await svc(mgr).post('', { ...opsBody, title: 'E2E: ticket reissue from KBiz Books' });
    check('created from KBiz Books: the three are added too', erpOps.status === 201 && JSON.stringify(watcherIds(erpOps.body)) === JSON.stringify([id(harshit), id(asif), id(farhan)]), erpOps.body);

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
    check('Start chat on a converted task; the giver then gets the same chat', e1.status === 200 && !!e1.body.chatId && e2.body.chatId === e1.body.chatId, [e1.body, e2.body]);
  } finally {
    await disconnectMongo();
    for (const name of [CRM_DB, APP_DB]) {
      if (!name.startsWith('kb360_tasks_e2e_')) throw new Error(`refusing to drop ${name}`);
      await raw.db(name).dropDatabase();
    }
    const { rmSync } = await import('fs');
    rmSync(process.env.STORAGE_LOCAL_DIR as string, { recursive: true, force: true });
    await raw.close();
  }
  console.log(`\n${pass} passed, ${fail} failed (throwaway DBs dropped)`);
  process.exit(fail ? 1 : 0);
}

void main().catch((e) => { console.error(e); process.exit(1); });
