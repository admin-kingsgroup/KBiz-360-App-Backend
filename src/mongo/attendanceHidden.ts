import { crmRepo } from './crm.repo';

// HIDDEN (background) attendance — company directors whose attendance is recorded fully
// automatically and invisibly (owner call, 07-31): no manual punching, no face photo, no branch
// attendance alerts, excluded from non-super team views and from the branch day-close report.
// Their day summary goes ONLY to the super-admin 'Directors Attendance' alerts channel.
//
// Membership is by email (stable across environments); override without a code change via the
// ATTENDANCE_HIDDEN_EMAILS env var (comma-separated). Emails resolve to CRM user ids at runtime
// with a short cache, mirroring attendanceExempt's shape.
const HIDDEN_EMAILS: string[] = (process.env.ATTENDANCE_HIDDEN_EMAILS
  || 'farhan@travkings.com,pravesh@travkings.com,lamiya@travkings.com')
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
