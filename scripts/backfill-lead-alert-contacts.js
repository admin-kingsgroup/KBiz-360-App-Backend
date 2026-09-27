#!/usr/bin/env node
/* Give the "Lead converted" alerts sent BEFORE the contact change (2026-09-27) the client's name
 * and number, so their cards show the WhatsApp + Call buttons too. Alerts created after the change
 * carry the contact from the CRM already; this only fills in the older ones.
 *
 *   node scripts/backfill-lead-alert-contacts.js            # dry run: lists what it would set
 *   node scripts/backfill-lead-alert-contacts.js --apply    # sets it
 *
 * Run INSIDE the app container (it carries MONGODB_URI / APP_DB / CRM_DB and the driver):
 *
 *   ssh ubuntu@kbiz360.duckdns.org 'docker exec -i kb360 node -' < scripts/backfill-lead-alert-contacts.js
 *   ssh ubuntu@kbiz360.duckdns.org 'docker exec -i kb360 node - --apply' < scripts/backfill-lead-alert-contacts.js
 *
 * For every event in a CRM channel (tk_lead_*) that has no contact: the QRY number in its body →
 * the CRM query with that query_number → its lead (query.lead_id) → the lead's phone, read against
 * the country of the lead's branch → { name, phone }. It only ever $sets `contact` on an event that
 * has none — nothing else is written, and a re-run changes nothing. Events it cannot match (no QRY
 * number, no lead, a number that cannot be made international) are listed and left alone.
 * The phones show the buttons only from app backend #5 on (the build that returns `contact`).
 */
require('dotenv').config();
const { MongoClient } = require('mongodb');

const APPLY = process.argv.includes('--apply');

// A number typed without its country code belongs to the lead's branch country — the same rule
// the CRM stores new leads with (crm-backend shared/utils/phone), cut down to the four countries
// the branches are in; this container has no libphonenumber. Mobile national numbers only.
const COUNTRY = { BOM: 'IN', AMD: 'IN', MHUB: 'IN', INB: 'IN', NBO: 'KE', HNBO: 'KE', DAR: 'TZ', HDAR: 'TZ', FBM: 'CD', HFBM: 'CD' };
const CC = { IN: '91', KE: '254', TZ: '255', CD: '243' };
const MOBILE = { IN: /^[6-9]\d{9}$/, KE: /^[17]\d{8}$/, TZ: /^[67]\d{8}$/, CD: /^[89]\d{8}$/ };
const E164 = /^\+[1-9]\d{7,14}$/;
function toE164(raw, country) {
  let s = String(raw || '').trim().replace(/[\s().-]/g, '');
  if (s.startsWith('00')) s = `+${s.slice(2)}`;
  const cc = CC[country];
  const mobile = MOBILE[country];
  if (cc && mobile) {
    const n = s.replace(/\D/g, '').replace(/^0+/, '');
    if (n.startsWith(cc) && mobile.test(n.slice(cc.length))) return `+${n}`; // +91…, 91…
    if (mobile.test(n)) return `+${cc}${n}`; // 98765…, 098765…, and the old importer's "+98765…"
  }
  return s.startsWith('+') && E164.test(s) ? s : null; // a foreign client's own international number
}
// The Africa rows say HNBO/HDAR/HFBM since 2026-09-16; the channels keep the short codes.
const canonical = (code) => ({ HNBO: 'NBO', HDAR: 'DAR', HFBM: 'FBM' })[code] || code;
const mask = (p) => String(p || '').replace(/[\s().-]/g, '').replace(/^(\+?\d{3})\d+(\d{3})$/, '$1…$2');
const fullName = (l) => [l.first_name, l.last_name].filter(Boolean).join(' ').trim();

(async () => {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!uri) { console.error('No MONGODB_URI — run inside the app container'); process.exit(1); }
  const appDbName = process.env.APP_DB || 'kb360_app';
  const crmDbName = process.env.CRM_DB;
  if (!crmDbName) { console.error('No CRM_DB — refusing to guess which database holds the leads'); process.exit(1); }
  const client = new MongoClient(uri);
  await client.connect();
  try {
    const app = client.db(appDbName);
    const crm = client.db(crmDbName);
    console.log(`app db = ${app.databaseName} · crm db = ${crm.databaseName} · mode = ${APPLY ? 'APPLY' : 'DRY RUN'}\n`);

    const events = await app.collection('alert_events')
      .find({ channelId: /^tk_lead_/, 'contact.phone': { $exists: false } })
      .project({ channelId: 1, title: 1, body: 1, time: 1 })
      .sort({ time: 1 })
      .toArray();
    const branchCode = new Map((await crm.collection('branches').find({}).project({ code: 1 }).toArray())
      .map((b) => [String(b._id), String(b.code || '').toUpperCase()]));

    const plan = [];
    const skipped = [];
    for (const e of events) {
      const qry = (String(e.body || '').match(/QRY-\d{4}-\d+/) || [])[0];
      const label = `${e.channelId}  ${new Date(e.time).toISOString().slice(0, 16)}  ${e.title}`;
      if (!qry) { skipped.push(`${label}  — no QRY number in the body`); continue; }
      // query_number is unique per tenant; with more than one tenant, the channel's branch decides.
      const channelBranch = e.channelId.replace(/^tk_lead_/, '').toUpperCase();
      const queries = await crm.collection('queries').find({ query_number: qry }).project({ lead_id: 1, branch_id: 1 }).toArray();
      const q = queries.length === 1 ? queries[0]
        : queries.find((x) => canonical(branchCode.get(String(x.branch_id))) === channelBranch);
      if (!q) { skipped.push(`${label}  — ${queries.length ? 'several queries' : 'no query'} numbered ${qry}`); continue; }
      if (!q.lead_id) { skipped.push(`${label}  — ${qry} has no lead`); continue; }
      const lead = await crm.collection('leads').findOne({ _id: q.lead_id }, { projection: { first_name: 1, last_name: 1, phone: 1, branch_id: 1 } });
      if (!lead) { skipped.push(`${label}  — the lead of ${qry} is gone`); continue; }
      const code = branchCode.get(String(lead.branch_id || q.branch_id)) || '?';
      const phone = toE164(lead.phone, COUNTRY[code]);
      if (!phone) { skipped.push(`${label}  — ${qry}: "${mask(lead.phone)}" (${code}) is not an international number`); continue; }
      const name = fullName(lead);
      plan.push({ _id: e._id, label, qry, code, from: lead.phone, contact: name ? { name: name.slice(0, 120), phone } : { phone } });
    }

    console.log(`${events.length} lead alert(s) without a contact · ${plan.length} can be filled · ${skipped.length} left alone\n`);
    for (const p of plan) console.log(`  SET   ${p.label}\n        ${p.qry} · ${p.code} · ${mask(p.from)} → ${mask(p.contact.phone)}${p.contact.name ? ` (${p.contact.name})` : ''}`);
    for (const s of skipped) console.log(`  SKIP  ${s}`);

    if (!APPLY) { console.log('\nDry run — nothing written. Re-run with --apply to set these contacts.'); return; }
    let n = 0;
    for (const p of plan) {
      const r = await app.collection('alert_events').updateOne({ _id: p._id, 'contact.phone': { $exists: false } }, { $set: { contact: p.contact } });
      n += r.modifiedCount;
    }
    console.log(`\nAPPLY: contact set on ${n} of ${plan.length} alert(s). Phones pick it up the next time the Alerts screen opens.`);
  } finally {
    await client.close();
  }
})().catch((e) => { console.error(e); process.exit(1); });
