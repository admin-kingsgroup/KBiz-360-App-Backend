#!/usr/bin/env node
/* READ-ONLY: who can see an alert channel — the same rule GET /api/alerts applies
 * (alert.service.listFor → alertGrants.effectiveFor → visibleChannelIds). Writes nothing.
 *
 *   ssh ubuntu@kbiz360.duckdns.org 'docker exec -i kb360 node - tk_lead_bom' < scripts/who-sees-alert-channel.js
 *
 * Channel ids: tk_lead_<br> (CRM), tk_crmrep_<br> (CRM Reports), tk_hr_<br>, tk_erp_<br>,
 * tk_erprep_<br> (grant-only).
 *   super-admin           — role level 1 or '*' permission: every channel
 *   company-wide          — role level ≤ 2: every branch's CRM / CRM Reports channels
 *   branch member         — CRM branch_ids include the channel's branch (branch-wide channels only)
 *   granted               — a Team & Users switch (grant-only channels only; stored switches are
 *                           ignored for branch-wide channels)
 * Inactive CRM users and users switched off for the app are listed separately — they cannot log in.
 */
require('dotenv').config();
const { MongoClient } = require('mongodb');

const channelId = (process.argv[2] || 'tk_lead_bom').toLowerCase();
const m = /^tk_(lead|crmrep|hr|erp|erprep)_([a-z]+)$/.exec(channelId);
if (!m) { console.error(`Unknown channel id "${channelId}" — e.g. tk_lead_bom`); process.exit(1); }
const MODULE = { lead: 'leads', crmrep: 'crm-reports', hr: 'attendance', erp: 'erp', erprep: 'erp-reports' }[m[1]];
const BRANCH = m[2].toUpperCase();
const BRANCH_WIDE = MODULE === 'leads' || MODULE === 'crm-reports';
const GRANT = `${BRANCH}-${MODULE}`;
const canonical = (code) => ({ HNBO: 'NBO', HDAR: 'DAR', HFBM: 'FBM' })[String(code || '').toUpperCase()] || String(code || '').toUpperCase();

(async () => {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  const crmDbName = process.env.CRM_DB;
  if (!uri || !crmDbName) { console.error('Run inside the app container (needs MONGODB_URI + CRM_DB)'); process.exit(1); }
  const client = new MongoClient(uri);
  await client.connect();
  try {
    const app = client.db(process.env.APP_DB || 'kb360_app');
    const crm = client.db(crmDbName);
    const roles = new Map((await crm.collection('roles').find({}).project({ name: 1, level: 1, permissions: 1 }).toArray()).map((r) => [String(r._id), r]));
    const branchIds = new Set((await crm.collection('branches').find({}).project({ code: 1 }).toArray())
      .filter((b) => canonical(b.code) === BRANCH).map((b) => String(b._id)));
    const grants = new Map((await app.collection('alert_grants').find({}).toArray()).map((g) => [String(g.userId), g.alerts || []]));
    const appOff = new Set((await app.collection('app_access').find({ disabled: true }).project({ userId: 1 }).toArray()).map((d) => String(d.userId)));
    const users = await crm.collection('users').find({}).project({ first_name: 1, last_name: 1, email: 1, role_id: 1, branch_ids: 1, status: 1, access: 1 }).toArray();

    const rows = [];
    const cannotLogIn = [];
    for (const u of users) {
      const role = roles.get(String(u.role_id));
      const level = role?.level ?? 5;
      const isSuper = level === 1 || (role?.permissions || []).includes('*');
      const companyWide = level <= 2;
      const inBranch = (u.branch_ids || []).some((b) => branchIds.has(String(b)));
      const granted = !BRANCH_WIDE && (grants.get(String(u._id)) || []).includes(GRANT);
      const why = isSuper ? 'super-admin' : BRANCH_WIDE && companyWide ? 'company-wide' : BRANCH_WIDE && inBranch ? 'branch member' : granted ? 'granted' : null;
      if (!why) continue;
      const row = { name: `${u.first_name || ''} ${u.last_name || ''}`.trim() || '(no name)', email: u.email || '', role: role?.name || '(no role)', why };
      if (u.status !== 'active' || u.access?.app === false || appOff.has(String(u._id))) cannotLogIn.push(row);
      else rows.push(row);
    }
    const order = { 'super-admin': 0, 'company-wide': 1, 'branch member': 2, granted: 3 };
    rows.sort((a, z) => order[a.why] - order[z.why] || a.name.localeCompare(z.name));

    console.log(`${channelId} (${BRANCH_WIDE ? 'branch-wide' : 'grant-only'}, grant ${GRANT}) — ${rows.length} user(s) can see it:\n`);
    for (const r of rows) console.log(`  ${r.why.padEnd(14)} ${r.name.padEnd(28)} ${r.role.padEnd(18)} ${r.email}`);
    if (cannotLogIn.length) {
      console.log(`\n${cannotLogIn.length} more would qualify but cannot log in (inactive in the CRM or switched off for the app):`);
      for (const r of cannotLogIn) console.log(`  ${r.why.padEnd(14)} ${r.name.padEnd(28)} ${r.role.padEnd(18)} ${r.email}`);
    }
  } finally {
    await client.close();
  }
})().catch((e) => { console.error(e); process.exit(1); });
