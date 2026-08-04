import { crmRepo } from './crm.repo';

// HIDDEN (background) attendance — accounts whose attendance is recorded fully automatically and
// invisibly: no manual punching, no face photo, no branch attendance alerts, excluded from
// non-super team views and from the branch day-close report. Their day summary goes ONLY to the
// super-admin 'Directors Attendance' alerts channel.
//
// EMPTY by default (owner call, 08-04): the automatic geofence punches produced mismatched
// check-outs (indoor GPS drift closing the day), so every account — directors included — punches
// manually. Re-enable per environment via the ATTENDANCE_HIDDEN_EMAILS env var (comma-separated
// emails); they resolve to CRM user ids at runtime with a short cache, mirroring attendanceExempt.
const HIDDEN_EMAILS: string[] = (process.env.ATTENDANCE_HIDDEN_EMAILS ?? '')
  .split(',')
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean);

let cache: Set<string> | null = null;
let cacheAt = 0;
const CACHE_TTL_MS = 60_000;

export const attendanceHidden = {
  emails: (): string[] => [...HIDDEN_EMAILS],

  async hiddenSet(): Promise<Set<string>> {
    if (cache && Date.now() - cacheAt < CACHE_TTL_MS) return cache;
    const ids = new Set<string>();
    for (const email of HIDDEN_EMAILS) {
      try {
        const u = await crmRepo.findUserByEmail(email);
        if (u) ids.add(String(u._id));
      } catch { /* CRM briefly unreachable — retry on next cache miss */ }
    }
    // Only adopt the cache when every email resolved OR we at least found someone — an empty set
    // from a transient DB error must not stick for a minute and leak punches into branch alerts.
    if (ids.size > 0) { cache = ids; cacheAt = Date.now(); }
    return ids;
  },

  async isHidden(userId: string): Promise<boolean> {
    return (await this.hiddenSet()).has(userId);
  },
};
