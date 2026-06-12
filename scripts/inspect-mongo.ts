/* eslint-disable no-console */
// READ-ONLY inspection of the external MongoDB. Issues ONLY listDatabases / listCollections /
// countDocuments / find. It NEVER writes, updates, deletes, or creates anything.
import 'dotenv/config';
import { MongoClient } from 'mongodb';

const SENSITIVE = /(pass|secret|token|hash|salt|otp|key)/i;

function shapeOf(doc: Record<string, unknown>, depth = 0): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(doc)) {
    if (SENSITIVE.test(k)) {
      out[k] = '<redacted>';
      continue;
    }
    if (v === null) out[k] = 'null';
    else if (Array.isArray(v)) out[k] = `array[${v.length}]${v.length && typeof v[0] === 'object' ? ' of object' : v.length ? ` of ${typeof v[0]}` : ''}`;
    else if (v instanceof Date) out[k] = 'Date';
    else if (typeof v === 'object') out[k] = depth < 1 ? `object{${Object.keys(v as object).join(',')}}` : 'object';
    else out[k] = typeof v;
  }
  return out;
}

function sampleValues(doc: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(doc)) {
    if (SENSITIVE.test(k)) out[k] = '<redacted>';
    else if (Array.isArray(v)) out[k] = v.slice(0, 4);
    else if (v && typeof v === 'object' && !(v instanceof Date)) out[k] = '{…}';
    else out[k] = v;
  }
  return out;
}

async function main(): Promise<void> {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI not set');
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 8000 });
  await client.connect();
  console.log('Connected (read-only inspection).\n');

  const admin = client.db().admin();
  const { databases } = await admin.listDatabases();
  const userDbs = databases.filter((d) => !['admin', 'local', 'config'].includes(d.name));
  console.log('Databases:', databases.map((d) => d.name).join(', '), '\n');

  for (const db of userDbs) {
    const d = client.db(db.name);
    const cols = await d.listCollections().toArray();
    console.log(`\n══════════ DB: ${db.name} (${cols.length} collections) ══════════`);
    for (const c of cols) {
      const col = d.collection(c.name);
      const count = await col.countDocuments();
      const docs = await col.find({}).limit(2).toArray();
      console.log(`\n── ${c.name}  (${count} docs)`);
      if (docs[0]) {
        console.log('   fields:', JSON.stringify(shapeOf(docs[0] as Record<string, unknown>)));
        console.log('   sample:', JSON.stringify(sampleValues(docs[0] as Record<string, unknown>)));
      } else {
        console.log('   (empty)');
      }
    }
  }

  await client.close();
  console.log('\nDone. No writes were performed.');
}

main().catch((e) => {
  console.error('Inspection error:', (e as Error).message);
  process.exit(1);
});
