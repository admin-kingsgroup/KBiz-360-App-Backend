#!/usr/bin/env node
/* Provision the identity the scheduled finance reports are posted as.
 *
 * The ERP's daily Receivables / Payables ageing and Bank & Cash reports land in the branch
 * Finance group chats (HQ - <BR> Finance) as ordinary messages. A chat message needs a sender,
 * and the app resolves a sender's display name from the shared CRM `users` collection — so
 * without an account behind it, every report would read "Member" in the bubble and
 * "New message" in the push. This creates that account ONCE:
 *
 *     KBiz Books <kbiz.books@travkings.com>   — no password, all app access flags off
 *
 * It cannot log in anywhere: there is no password hash to compare against and access.{app,crm,erp}
 * are false. It exists so a name resolves.
 *
 * Run with a WRITE-capable connection string — the app's own MONGODB_URI is read-only on the CRM
 * database by design (DB_LEAST_PRIVILEGE.md):
 *
 *     node scripts/ensure-report-sender.js --uri "mongodb+srv://…"
 *     CRM_WRITE_MONGODB_URI="mongodb+srv://…" node scripts/ensure-report-sender.js
 *
 * Idempotent: re-running only tops up missing fields (and re-attaches any branch opened since).
 */
require('dotenv').config();
const { MongoClient } = require('mongodb');

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};

const EMAIL = (process.env.REPORT_CHAT_SENDER_EMAIL || 'kbiz.books@travkings.com').toLowerCase().trim();
const FIRST = 'KBiz';
const LAST = 'Books';

(async () => {
  const uri = arg('uri', process.env.CRM_WRITE_MONGODB_URI || process.env.MONGODB_URI || process.env.MONGO_URI);
  if (!uri) { console.error('No connection string — pass --uri or set CRM_WRITE_MONGODB_URI'); process.exit(1); }
  const client = new MongoClient(uri);
  await client.connect();
  try {
    const db = client.db(process.env.CRM_DB || 'test');
    const users = db.collection('users');

    const existing = await users.findOne({ email: EMAIL });

    // Tenant/company are copied from the live directory rather than configured: the account must
    // sit in the SAME tenant as the people who read the reports, or the directory (which is
    // tenant-scoped) will not resolve its name for them.
    const sample = await users.findOne({ tenant_id: { $ne: null }, email: { $ne: EMAIL } }, { sort: { created_at: 1 } });
    if (!sample) { console.error('No tenanted user found to copy tenant/company from — is this the right database?'); process.exit(1); }

    // Every branch: the directory is ALSO branch-scoped for branch-limited roles, so a sender
    // attached to one branch would read as "Member" for everyone outside it.
    const branchIds = (await db.collection('branches').find({}).project({ _id: 1 }).toArray()).map((b) => b._id);
    const roles = await db.collection('roles').find({}).project({ name: 1 }).toArray();
    const employeeRole = roles.find((r) => String(r.name).toLowerCase() === 'employee');

    const now = new Date();
    const base = {
      tenant_id: sample.tenant_id,
      company_id: sample.company_id ?? null,
      role_id: employeeRole ? employeeRole._id : (sample.role_id ?? null),
      branch_id: null,
      branch_ids: branchIds,
      department_id: null,
      email: EMAIL,
      first_name: FIRST,
      last_name: LAST,
      status: 'active',
      email_verified: true,
      // Not a person and not a login: no password field at all, and every app switched off.
      access: { app: false, crm: false, erp: false },
      notification_settings: { email: false, whatsapp: false, in_app: false },
      updated_at: now,
      updatedAt: now,
    };

    if (existing) {
      await users.updateOne({ _id: existing._id }, { $set: base, $unset: { password: '' } });
      console.log(`Report sender already existed — refreshed. id=${existing._id} (${branchIds.length} branches)`);
      console.log(`REPORT_CHAT_SENDER_ID=${existing._id}`);
    } else {
      const res = await users.insertOne({ ...base, refresh_tokens: [], created_at: now, __v: 0 });
      console.log(`Report sender created. id=${res.insertedId} (${branchIds.length} branches)`);
      console.log(`REPORT_CHAT_SENDER_ID=${res.insertedId}`);
    }
  } finally {
    await client.close();
  }
})().catch((e) => { console.error(e.message); process.exit(1); });
