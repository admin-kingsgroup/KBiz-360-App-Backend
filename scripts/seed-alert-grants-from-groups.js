#!/usr/bin/env node
/* Switch on the new HR / ERP / ERP Reports alert channels for the people who read those feeds in
 * the branch GROUP CHATS until 2026-09-27, so nobody loses anything when the feeds move to Alerts.
 *
 *   node scripts/seed-alert-grants-from-groups.js            # dry run: prints who gets what
 *   node scripts/seed-alert-grants-from-groups.js --apply    # adds the grants
 *
 * Run INSIDE the app container (it carries MONGODB_URI / APP_DB / CRM_DB and the driver):
 *
 *   ssh ubuntu@kbiz360.duckdns.org 'docker exec -i kb360 node - --apply' < scripts/seed-alert-grants-from-groups.js
 *
 * Per branch code (BOM, AMD, NBO, DAR, FBM, MHUB), members of:
 *   HR          ← its HR group ("HQ - BOM HR" / "BOM - HR Team" / "BOM HR"), else its Finance group
 *                 (the same fallback attendance posting used)                       → "<BR>-attendance"
 *   ERP Reports ← its Finance group ("HQ - BOM Finance" / "MHUB - Finance Team")     → "<BR>-erp-reports"
 *   ERP         ← "<BR> - Branch Accounts", "<BR> - Ticketing", "<BR> - Holidays" and every
 *                 INB/Hub Ticketing|Holidays pair room the branch is in              → "<BR>-erp"
 * Group names are matched on the SQUASHED name, exactly as the report router matched them.
 *
 * Additive only: grants a user already holds are kept ($addToSet). Super-admins are skipped (they
 * see every channel anyway), as are inactive users and the login-less "KBiz Books" sender.
 * Re-runnable — a second run adds nothing.
 */
require('dotenv').config();
const { MongoClient } = require('mongodb');

const APPLY = process.argv.includes('--apply');
const CODES = ['BOM', 'AMD', 'NBO', 'DAR', 'FBM', 'MHUB'];
// Groups may be named with either spelling of an Africa branch: the ERP renamed the codes on
// 2026-09-16 (NBO→HNBO, DAR→HDAR, FBM→HFBM). The grant always uses the app's short code.
const SPELLINGS = { NBO: ['nbo', 'hnbo'], DAR: ['dar', 'hdar'], FBM: ['fbm', 'hfbm'] };
const squash = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const spellings = (code) => SPELLINGS[code] || [squash(code)];
const ALL_SPELLINGS = CODES.flatMap(spellings);

const hrKeys = (code) => spellings(code).flatMap((c) => [`hq${c}hr`, `${c}hrteam`, `${c}hr`]);
const financeKeys = (code) => spellings(code).flatMap((c) => [`hq${c}finance`, `${c}financeteam`]);
const erpKeys = (code) => spellings(code).flatMap((c) => [`${c}branchaccounts`, `${c}ticketing`, `${c}holidays`]);
// "INB Ticketing AMD/BOM", "Hub Holidays BOM/AMD" … either order.
const pairRoomOf = (name, code) => {
  const n = squash(name);
  for (const pre of ['inb', 'hub']) {
    for (const desk of ['ticketing', 'holidays']) {
      const head = `${pre}${desk}`;
      if (!n.startsWith(head)) continue;
      const rest = n.slice(head.length);
      for (const c of spellings(code)) {
        for (const other of ALL_SPELLINGS) {
          if (spellings(code).includes(other)) continue;
          if (rest === `${c}${other}` || rest === `${other}${c}`) return true;
        }
      }
    }
  }
  return false;
};

(async () => {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!uri) { console.error('No MONGODB_URI — run inside the app container'); process.exit(1); }
  const appDbName = process.env.APP_DB || 'kb360_app';
  const crmDbName = process.env.CRM_DB;
  if (!crmDbName) { console.error('No CRM_DB — refusing to guess which database holds the users'); process.exit(1); }
  const client = new MongoClient(uri);
  await client.connect();
  try {
    const app = client.db(appDbName);
    const crm = client.db(crmDbName);
    console.log(`app db = ${app.databaseName} · crm db = ${crm.databaseName} · mode = ${APPLY ? 'APPLY' : 'DRY RUN'}\n`);

    const roles = await crm.collection('roles').find({}).project({ level: 1, permissions: 1 }).toArray();
    const superRole = new Set(roles.filter((r) => r.level === 1 || (r.permissions || []).includes('*')).map((r) => String(r._id)));
    const users = await crm.collection('users').find({ status: 'active' }).project({ first_name: 1, last_name: 1, email: 1, role_id: 1 }).toArray();
    const active = new Map(users.map((u) => [String(u._id), u]));
    const nameOf = (id) => { const u = active.get(id); return u ? `${u.first_name || ''} ${u.last_name || ''}`.trim() || u.email : id; };
    const skip = (id) => {
      const u = active.get(id);
      return !u || superRole.has(String(u.role_id)) || String(u.email || '').toLowerCase() === 'kbiz.books@travkings.com';
    };

    const groups = await app.collection('conversations').find({ type: 'group' }).project({ name: 1, participantIds: 1 }).toArray();
    const byKey = new Map();
    for (const g of groups) byKey.set(squash(g.name), [...(byKey.get(squash(g.name)) || []), g]);
    const find = (keys) => keys.flatMap((k) => byKey.get(k) || []);

    const add = new Map(); // userId → Set(grants)
    const give = (ids, grant) => { for (const id of ids) if (!skip(id)) add.set(id, (add.get(id) || new Set()).add(grant)); };
    const members = (gs) => [...new Set(gs.flatMap((g) => (g.participantIds || []).map(String)))];

    for (const code of CODES) {
      const fin = find(financeKeys(code));
      const hr = find(hrKeys(code));
      const erp = [...find(erpKeys(code)), ...groups.filter((g) => pairRoomOf(g.name, code))];
      const hrSource = hr.length ? hr : fin;
      give(members(hrSource), `${code}-attendance`);
      give(members(fin), `${code}-erp-reports`);
      give(members(erp), `${code}-erp`);
      const show = (gs) => (gs.length ? gs.map((g) => `"${g.name}" (${(g.participantIds || []).length})`).join(', ') : '— none —');
      console.log(`${code}`);
      console.log(`  HR          ← ${show(hrSource)}${hr.length ? '' : '  [no HR group → Finance group]'}`);
      console.log(`  ERP Reports ← ${show(fin)}`);
      console.log(`  ERP         ← ${show(erp)}`);
    }

    const existing = new Map((await app.collection('alert_grants').find({ userId: { $in: [...add.keys()] } }).toArray()).map((d) => [d.userId, new Set(d.alerts || [])]));
    let changed = 0;
    console.log('\nPer user (new grants only):');
    for (const [id, set] of [...add].sort((a, b) => nameOf(a[0]).localeCompare(nameOf(b[0])))) {
      const have = existing.get(id) || new Set();
      const fresh = [...set].filter((g) => !have.has(g)).sort();
      if (!fresh.length) continue;
      changed += 1;
      console.log(`  ${nameOf(id).padEnd(28)} + ${fresh.join(', ')}`);
      if (APPLY) {
        await app.collection('alert_grants').updateOne(
          { userId: id },
          { $addToSet: { alerts: { $each: fresh } }, $set: { userId: id, updatedBy: 'seed-alert-grants-2026-09-27', updatedAt: new Date() } },
          { upsert: true },
        );
      }
    }
    console.log(`\n${changed} user(s) ${APPLY ? 'updated' : 'would be updated'}.${APPLY ? '' : ' Re-run with --apply to write.'}`);
  } finally {
    await client.close();
  }
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
