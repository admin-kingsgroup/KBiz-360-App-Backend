#!/usr/bin/env node
/* Delete a channel family out of the System Alerts section — events, stored files and grants.
 *
 *   node scripts/purge-alert-channels.js --prefix tk_ar_,tk_ap_,tk_bc_ --grants receivables,payables,bankcash
 *   …add --apply to actually delete (default is a dry run that only counts).
 *
 * Used 2026-08-19 to retire Clients Receivables / Supplier Payables / Bank & Cash: those reports
 * moved into the branch Finance group chats, so their one-way channels, their 90-day event history
 * and the ageing/balance PDFs those events carried are all dead weight.
 *
 * Order matters: the stored file is deleted FIRST and the event only after, so a crash mid-run
 * leaves an event whose attachment 404s (visible, re-runnable) rather than an orphaned S3 object
 * nothing points at any more. Run INSIDE the app container so the storage adapter has the same
 * driver + credentials the events were written with:
 *
 *   ssh ubuntu@kbiz360.duckdns.org 'docker exec -i kb360 node' < scripts/purge-alert-channels.js -- …
 *
 * (or `docker exec kb360 node scripts/purge-alert-channels.js …` if the image carries scripts/).
 */
require('dotenv').config();
const { MongoClient } = require('mongodb');

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};
const APPLY = process.argv.includes('--apply');
const PREFIXES = arg('prefix', '').split(',').map((s) => s.trim()).filter(Boolean);
const GRANT_MODULES = arg('grants', '').split(',').map((s) => s.trim()).filter(Boolean);

// The storage adapter is TypeScript; inside the container only the built dist/ exists. Fall back to
// a direct S3 delete when neither is loadable (a local-driver install has nothing to delete anyway).
function loadStorage() {
  const path = require('path');
  // Both layouts: run as a file from scripts/ (…/../dist), and piped in on stdin inside the
  // container, where a relative require resolves against the WORKDIR instead of this file.
  const candidates = [
    path.join(__dirname, '../dist/storage'), path.join(__dirname, '../src/storage'),
    path.join(process.cwd(), 'dist/storage'), path.join(process.cwd(), 'src/storage'),
  ];
  for (const p of candidates) {
    try { return require(p).getStorage(); } catch { /* try the next */ }
  }
  return null;
}

(async () => {
  if (!PREFIXES.length) { console.error('Nothing to do — pass --prefix tk_ar_,tk_ap_,tk_bc_'); process.exit(1); }
  const uri = arg('uri', process.env.MONGODB_URI || process.env.MONGO_URI);
  if (!uri) { console.error('No connection string — pass --uri or set MONGODB_URI'); process.exit(1); }
  const client = new MongoClient(uri);
  await client.connect();
  try {
    const db = client.db(process.env.APP_DB || 'kb360_app');
    const events = db.collection('alert_events');
    const rx = new RegExp(`^(${PREFIXES.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`);

    const doomed = await events.find({ channelId: rx }).project({ channelId: 1, attachment: 1 }).toArray();
    const byChannel = {};
    for (const d of doomed) byChannel[d.channelId] = (byChannel[d.channelId] || 0) + 1;
    for (const [ch, n] of Object.entries(byChannel).sort()) console.log(`  ${ch.padEnd(12)} ${String(n).padStart(4)} event(s)`);
    const withFiles = doomed.filter((d) => d.attachment && d.attachment.key);
    console.log(`\n${doomed.length} event(s), ${withFiles.length} with a stored file`);

    if (!APPLY) {
      const g = await db.collection('alert_grants').countDocuments({ alerts: { $regex: `-(${GRANT_MODULES.join('|')})$` } });
      console.log(`${g} grant doc(s) reference ${GRANT_MODULES.join('/')}\n\nDry run — pass --apply to delete.`);
      return;
    }

    const storage = loadStorage();
    let files = 0, missed = 0;
    for (const d of withFiles) {
      try { if (storage) await storage.delete(String(d.attachment.key)); files += 1; }
      catch (e) { missed += 1; console.warn(`  could not delete ${d.attachment.key}: ${e.message}`); }
    }
    const del = await events.deleteMany({ channelId: rx });
    console.log(`\n✅ deleted ${del.deletedCount} event(s) and ${files} stored file(s)${missed ? ` (${missed} file(s) failed — re-run to retry)` : ''}`);
    if (!storage) console.warn('⚠ storage adapter not loadable here — files were NOT deleted; re-run inside the app container');

    // Per-user grants for the retired families: strip just those entries, keep the rest of the
    // user's grants (a super-admin's other channels must survive).
    if (GRANT_MODULES.length) {
      const grx = new RegExp(`-(${GRANT_MODULES.join('|')})$`);
      const docs = await db.collection('alert_grants').find({ alerts: { $regex: grx } }).toArray();
      let touched = 0;
      for (const doc of docs) {
        const kept = (doc.alerts || []).filter((a) => !grx.test(a));
        if (kept.length === (doc.alerts || []).length) continue;
        if (kept.length) await db.collection('alert_grants').updateOne({ _id: doc._id }, { $set: { alerts: kept, updatedAt: new Date() } });
        else await db.collection('alert_grants').deleteOne({ _id: doc._id });
        touched += 1;
      }
      console.log(`✅ cleaned ${touched} grant doc(s)`);
    }
  } finally {
    await client.close();
  }
})().catch((e) => { console.error(e.message); process.exit(1); });
