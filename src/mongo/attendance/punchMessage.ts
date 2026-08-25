// The one-line chat post a punch makes in its branch's group, and the key that keeps it to one
// line per person per direction per day.
//
// The branch half of a punch used to be a "X checked in" event in the Attendance alert channels;
// those channels went away 2026-08-19 and only the 10pm day-close summary survived into the group
// chats. This brings the live line back (owner call, 2026-08-25) — as an ordinary chat message in
// the same branch group the summary lands in, so the room sees arrivals as they happen and still
// gets the roll-up at close of day.
//
// Deliberately its own module with no imports: the poster it serves reaches into the CRM
// directory, the branch registry and the chat service, and both the wording and the noise rule
// are worth testing without any of that.

export type PunchAction = 'in' | 'out';

/** "🟢 Priya Patel checked in · 9:42 AM · Geofence" — time and method are dropped when unknown. */
export function punchChatLine(input: { name: string; action: PunchAction; time?: string | null; via?: string | null }): string {
  const dot = input.action === 'in' ? '🟢' : '🔴';
  const name = (input.name || '').trim() || 'Someone';
  return [`${dot} ${name} checked ${input.action}`, input.time, input.via]
    .filter((p) => !!p && String(p).trim())
    .join(' · ');
}

/** One post per (branch, day, user, direction).
 *
 *  A day can legitimately re-open — "first-in stays, last-out wins", so a lunchtime geofence drift
 *  followed by a re-entry writes a second check-in — and a phone sitting on the fence boundary can
 *  produce a run of them. The group is a room full of people, so it hears about an arrival and a
 *  departure once each; the authoritative final in/out times are in the 10pm summary either way. */
export function punchDedupeKey(branchCode: string, day: string, userId: string, action: PunchAction): string {
  return `attendance-punch-${branchCode}-${day}-${userId}-${action}`;
}
