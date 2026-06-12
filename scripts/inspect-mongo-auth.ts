/* eslint-disable no-console */
// READ-ONLY: focused look at the auth/org model (tenants, roles, users link, companies, branches).
// Only find/count. No writes. Emails shown (you own this data); password shown as ALGO PREFIX only.
import 'dotenv/config';
import { MongoClient } from 'mongodb';

async function main(): Promise<void> {
  const client = new MongoClient(process.env.MONGODB_URI!, { serverSelectionTimeoutMS: 8000 });
  await client.connect();
  // Auto-detect the db that actually holds users.
  const { databases } = await client.db().admin().listDatabases();
  let dbName = 'test';
  for (const d of databases.filter((x) => !['admin', 'local', 'config'].includes(x.name))) {
    const n = await client.db(d.name).collection('users').countDocuments().catch(() => 0);
    if (n > 0) { dbName = d.name; break; }
  }
  console.log('USING DB:', dbName, '\n');
  const db = client.db(dbName);

  const tenants = await db.collection('tenants').find({}).toArray();
  console.log('TENANTS:', tenants.map((t) => ({ id: String(t._id), name: t.name, slug: t.slug, status: t.status })));

  const roles = await db.collection('roles').find({}).toArray();
  console.log('\nROLES:');
  roles.forEach((r) => console.log('  ', { id: String(r._id), name: r.name, level: r.level, is_system: r.is_system, perms: Array.isArray(r.permissions) ? r.permissions.slice(0, 6) : r.permissions, permCount: Array.isArray(r.permissions) ? r.permissions.length : 0 }));

  const companies = await db.collection('companies').find({}).toArray();
  console.log('\nCOMPANIES:', companies.map((c) => ({ id: String(c._id), name: c.name, tenant: String(c.tenant_id) })));

  const branches = await db.collection('branches').find({}).toArray();
  console.log('\nBRANCHES:');
  branches.forEach((b) => console.log('  ', { id: String(b._id), name: b.name, code: b.code, company: String(b.company_id), isHO: b.isHO, city: b.city, country: b.country }));

  const roleById = new Map(roles.map((r) => [String(r._id), r.name]));
  const users = await db.collection('users').find({}).limit(25).toArray();
  console.log(`\nUSERS (${await db.collection('users').countDocuments()} total) — sample:`);
  users.slice(0, 6).forEach((u) => {
    const pw = typeof u.password === 'string' ? u.password.slice(0, 7) : '(none)';
    console.log('  ', {
      email: u.email,
      name: `${u.first_name ?? ''} ${u.last_name ?? ''}`.trim(),
      role: roleById.get(String(u.role_id)) ?? String(u.role_id),
      branch_ids: Array.isArray(u.branch_ids) ? u.branch_ids.length : 0,
      status: u.status,
      verified: u.email_verified,
      pwAlgo: pw, // e.g. "$2b$10$" = bcrypt
    });
  });
  // Distribution by role
  const byRole: Record<string, number> = {};
  users.forEach((u) => { const n = roleById.get(String(u.role_id)) ?? 'unknown'; byRole[n] = (byRole[n] ?? 0) + 1; });
  console.log('\nUSERS BY ROLE:', byRole);

  await client.close();
  console.log('\nDone (read-only).');
}
main().catch((e) => { console.error('err:', (e as Error).message); process.exit(1); });
