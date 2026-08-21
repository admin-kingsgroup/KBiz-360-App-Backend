#!/usr/bin/env node
/* Delete the ERP's text-only "deal summary" messages out of the desk group chats.
 *
 *   node scripts/purge-gp-summary-messages.js                 # dry run — counts and samples only
 *   node scripts/purge-gp-summary-messages.js --apply         # actually delete
 *   node scripts/purge-gp-summary-messages.js --apply --inb   # …INB pair rooms too (off by default)
 *
 * Every approved booking used to post TWO messages into "<BR> - Ticketing" / "<BR> - Holidays":
 * the customer invoice PDF, and a bare "Booking BKG/… approved — GP … · Sale … · Purchase … ·
 * Link …" line that only restated it. The ERP stopped emitting the summary on 2026-08-21
 * (bookingOrders doApprove no longer calls emitBookingGpAlert); this clears the ones already sent.
 *
 * Matched on the message's FIRST line, which is the alert's title verbatim:
 *     Booking <no> approved — GP …      RF reversal <no> approved — GP …      RI reversal …
 * The invoice messages ("Invoice <vno> approved", + PDF) are never matched — they are the ones
 * being kept. INB summaries ("INB <link> approved — GP … (SVF)") are ALSO kept unless --inb is
 * passed: an INB approval has no invoice, so that line is the only record its room ever gets.
 *
 * A hard delete, not a "This message was deleted" tombstone — a room full of tombstones is the
 * same noise wearing a different hat. Consequence: devices that already cached the thread keep
 * their local copy until the app clears its chat-db, since the delta sync only carries messages
 * that still exist. Server history, search and any fresh/reinstalled device are clean immediately.
 *
 * Repairs what the delete invalidates, per affected conversation: `lastMessage` (re-derived from
 * the newest surviving message) and every member's `unread` counter (recounted against their
 * lastReadAt), so no chat-list row is left previewing or badging a message that is gone.
 *
 * Run it against the app database, e.g. inside the container on the server:
 *   ssh ubuntu@kbiz360.duckdns.org 'docker exec -i kb360 node' < scripts/purge-gp-summary-messages.js
 * (piped stdin takes no argv — set PURGE_APPLY=1 / PURGE_INB=1 in the env instead of --apply/--inb).
 */
require('dotenv').config();
const { MongoClient, ObjectId } = require('mongodb');

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};
const flag = (name, env) => process.argv.includes(`--${name}`) || ['1', 'true', 'yes'].includes(String(process.env[env] || '').toLowerCase());
const APPLY = flag('apply', 'PURGE_APPLY');
const WITH_INB = flag('inb', 'PURGE_INB');

// The title line, anchored at the very start of the message text (title + "\n" + body).
// The em dash is the emitter's own — a hyphen here would match nothing.
const BOOKING_RX = /^(Booking|RF reversal|RI reversal) [^\n]*? approved — GP /;
const INB_RX = /^INB [^\n]*? approved — GP /;

(async () => {
  const uri = arg('uri', process.env.MONGODB_URI || process.env.MONGO_URI);
  if (!uri) { console.error('No connection string — pass --uri or set MONGODB_URI'); process.exit(1); }
  const client = new MongoClient(uri);
  await client.connect();
  try {
    const db = client.db(process.env.APP_DB || 'kb360_app');
    const messages = db.collection('messages');
    const conversations = db.collection('conversations');

    const patterns = [BOOKING_RX, ...(WITH_INB ? [INB_RX] : [])];
    const filter = { $or: patterns.map((rx) => ({ text: rx })) };
    const doomed = await messages.find(filter).project({ conversationId: 1, text: 1, sentAt: 1, attachments: 1 }).toArray();

    // A summary carries no PDF. Anything matching that DOES is not what this script is for — report
    // it and leave it alone rather than quietly destroying an attachment.
    const withFiles = doomed.filter((m) => Array.isArray(m.attachments) && m.attachments.length);
    const kill = doomed.filter((m) => !(Array.isArray(m.attachments) && m.attachments.length));

    const convIds = [...new Set(kill.map((m) => String(m.conversationId)))];
    const convs = await conversations.find({ _id: { $in: convIds.map((id) => new ObjectId(id)) } })
      .project({ name: 1 }).toArray();
    const nameOf = Object.fromEntries(convs.map((c) => [String(c._id), c.name || String(c._id)]));

    const byConv = {};
    for (const m of kill) byConv[String(m.conversationId)] = (byConv[String(m.conversationId)] || 0) + 1;
    for (const [id, n] of Object.entries(byConv).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(nameOf[id] || id).padEnd(24)} ${String(n).padStart(4)} message(s)`);
    }
    console.log(`\n${kill.length} summary message(s) across ${convIds.length} conversation(s)${WITH_INB ? ' (INB included)' : ' (INB kept)'}`);
    if (withFiles.length) console.log(`${withFiles.length} match(es) carry an attachment — SKIPPED, inspect by hand`);
    for (const m of kill.slice(0, 3)) console.log(`  e.g. ${JSON.stringify(String(m.text).split('\n')[0].slice(0, 110))}`);

    if (!kill.length) { console.log('\nNothing to delete.'); return; }
    if (!APPLY) { console.log('\nDry run — pass --apply (or PURGE_APPLY=1) to delete.'); return; }

    const res = await messages.deleteMany({ _id: { $in: kill.map((m) => m._id) } });
    console.log(`\nDeleted ${res.deletedCount} message(s). Repairing conversations…`);

    // lastMessage + unread must not outlive the messages they counted.
    for (const id of convIds) {
      const _id = new ObjectId(id);
      const conv = await conversations.findOne({ _id }, { projection: { members: 1, lastMessage: 1 } });
      if (!conv) continue;
      const [newest] = await messages.find({ conversationId: _id }).sort({ sentAt: -1, _id: -1 }).limit(1).toArray();
      const lastMessage = newest
        ? { messageId: newest._id, text: newest.text || '', type: newest.type || 'text', senderId: newest.senderId, at: newest.sentAt }
        : null;
      const members = [];
      for (const mem of conv.members || []) {
        const since = mem.lastReadAt ? { sentAt: { $gt: mem.lastReadAt } } : {};
        const unread = await messages.countDocuments({ conversationId: _id, senderId: { $ne: mem.userId }, ...since });
        members.push({ ...mem, unread });
      }
      const set = { members };
      if (String(conv.lastMessage && conv.lastMessage.messageId) !== String(lastMessage && lastMessage.messageId)) {
        set.lastMessage = lastMessage;
        if (lastMessage) set.lastActivityAt = lastMessage.at;
      }
      await conversations.updateOne({ _id }, { $set: set });
      console.log(`  ${String(nameOf[id] || id).padEnd(24)} repaired (${byConv[id]} removed)`);
    }
    console.log('\nDone.');
  } finally {
    await client.close();
  }
})().catch((e) => { console.error(e); process.exit(1); });
