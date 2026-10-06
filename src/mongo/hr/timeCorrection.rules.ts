import { instantAt } from './attendanceMonth';

// A TIME CORRECTION asked from the app is the SAME row the ERP's own "Correct time" files: an
// hr_leave_applications document of kind 'time' (owner, 2026-10-06 — "when a user raises a time
// change or a leave in the app it must also come to the ERP's approval section, under Leave, and
// after approval show on that person's calendar"). One row, two doors:
//
//   ERP   Approvals ▸ Leave — signed FM → Director → Owner (leaveApplication.controller); the
//         Owner's signature writes the day as Present with these times through the sheet's planner.
//   app   the Super Admin's Time-corrections queue — the Super Admin IS the Owner level of that
//         chain (app level 1 = business owner), so an in-app approval is the Owner signing past the
//         levels that have not signed, with the reason recorded on the row exactly as the ERP
//         records a sign-past (LEAVE-GATE-02), and the day written through applyAdminTimes — the
//         same evidence-preserving correction the ERP's planner makes.
//
// Everything here is PURE and mirrors the ERP's leaveApplication.service / approvalEngine (the
// 2nd copy — change both together). Times on the row are 'HH:MM' on the person's BRANCH clock,
// as the ERP keys and reads them; the app converts to and from instants at its doors.

export const LEAVE_CHAIN: readonly { order: number; role: string; label: string }[] = Object.freeze([
  Object.freeze({ order: 1, role: 'FinanceManager', label: 'Review (FM)' }),
  Object.freeze({ order: 2, role: 'Director', label: 'Confirm (Director)' }),
  Object.freeze({ order: 3, role: 'Owner', label: 'Approve (Owner)' }),
]);
export const OWNER_ROLE = 'Owner';
/** A fresh copy of the standing chain, as the ERP stamps it on every new application. */
export const freshChain = (): { order: number; role: string; label: string }[] => LEAVE_CHAIN.map((l) => ({ ...l }));

export interface ChainLevel { order: number; role: string; label: string }
export interface ChainSignature {
  role: string;
  by: string;
  at: Date;
  note?: string;
  skipped?: boolean;
  signedPastBy?: string;
  reason?: string;
}
/** The subset of an hr_leave_applications row the chain rules read. */
export interface ChainDoc { chain?: ChainLevel[] | null; approvals?: ChainSignature[] | null }

/** Pure: the row's chain — its own, or the standing one for a row from before (ERP `chainOf`). */
export function chainOf(doc: ChainDoc | null | undefined): ChainLevel[] {
  const own = doc && Array.isArray(doc.chain) && doc.chain.length ? doc.chain : LEAVE_CHAIN;
  return own.map((l) => ({ order: l.order, role: l.role, label: l.label }));
}

/** Pure: the label of the level the row waits on, '' when every level has signed (ERP `waitingOn`). */
export function waitingOn(doc: ChainDoc | null | undefined): string {
  const signed = new Set(((doc && doc.approvals) || []).map((a) => a.role));
  const next = chainOf(doc).sort((a, b) => a.order - b.order).find((l) => !signed.has(l.role));
  return next ? next.label : '';
}

/** Pure: the short names of the levels that have SIGNED (not signed past) — "FM", "Director". */
export const SHORT_ROLE: Record<string, string> = { FinanceManager: 'FM', Director: 'Director', Owner: 'Owner' };
export function signedBy(doc: ChainDoc | null | undefined): string[] {
  return ((doc && doc.approvals) || []).filter((a) => !a.skipped).map((a) => SHORT_ROLE[a.role] ?? a.role);
}

/** Pure: may `role` sign this ordered chain now? → { next, allowed, past } (ERP approvalEngine.orderedTurn).
 *  `past` = the unsigned levels before `role`'s own that its signature would skip. */
export function orderedTurn(chain: ChainLevel[], approvals: ChainSignature[], role: string): { next: ChainLevel | null; allowed: boolean; past: ChainLevel[] } {
  const signed = new Set((approvals || []).map((a) => a.role));
  const levels = [...(chain || [])].sort((a, b) => (a.order || 0) - (b.order || 0));
  const next = levels.find((l) => !signed.has(l.role)) || null;
  const at = levels.findIndex((l) => l.role === role);
  if (!next || at < 0 || signed.has(role)) return { next, allowed: false, past: [] };
  const from = levels.indexOf(next);
  if (at < from) return { next, allowed: false, past: [] };
  return { next, allowed: true, past: levels.slice(from, at).filter((l) => !signed.has(l.role)) };
}

/** Pure: the signatures the Super Admin's in-app approval adds — every level still unsigned before
 *  the Owner's is signed PAST (skipped, who and why), then the Owner's own (ERP `signaturesFor`).
 *  null when the Owner has already signed (the row cannot still be pending — refuse upstream). */
export function ownerSignatures(doc: ChainDoc, { by, at = new Date(), note = '', reason }: { by: string; at?: Date; note?: string; reason: string }): ChainSignature[] | null {
  const turn = orderedTurn(chainOf(doc), doc.approvals || [], OWNER_ROLE);
  if (!turn.allowed) return null;
  return [
    ...turn.past.map((l) => ({ role: l.role, by, at, skipped: true, signedPastBy: OWNER_ROLE, reason })),
    { role: OWNER_ROLE, by, at, note },
  ];
}

// ── the branch clock ─────────────────────────────────────────────────────────
// The ERP keys a correction's times on the person's BRANCH clock (taxRegime.branchTimezone: the
// branch master's `timezone`, else its country's zone, else head office's). Same table here.
export const COUNTRY_TZ: Record<string, string> = { IN: 'Asia/Kolkata', KE: 'Africa/Nairobi', TZ: 'Africa/Dar_es_Salaam', CD: 'Africa/Lubumbashi' };
const isValidTz = (tz: string): boolean => { try { new Intl.DateTimeFormat('en', { timeZone: tz }); return true; } catch { return false; } };
/** Pure: the IANA zone for a branch master row (`timezone` → `countryCode` → `dflt`). */
export function branchTimezoneOf(row: { timezone?: string | null; countryCode?: string | null } | null | undefined, dflt: string): string {
  const tz = String(row?.timezone ?? '').trim();
  if (tz && isValidTz(tz)) return tz;
  return COUNTRY_TZ[String(row?.countryCode ?? '').trim().toUpperCase()] || dflt;
}

/** Pure: 'HH:MM' wall clock of an instant in a zone — the inverse of attendanceMonth.instantAt. */
export function hhmmIn(tz: string, at: Date): string {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', hour: '2-digit', minute: '2-digit' }).formatToParts(at);
    const g = (t: string): string => String((parts.find((x) => x.type === t) || {}).value ?? '');
    const hh = String(Number(g('hour')) % 24).padStart(2, '0'); // ICU may render midnight as "24"
    return `${hh}:${g('minute').padStart(2, '0')}`;
  } catch {
    return `${String(at.getUTCHours()).padStart(2, '0')}:${String(at.getUTCMinutes()).padStart(2, '0')}`;
  }
}

/** Pure: the ERP-shaped times of a planned request — in / out as 'HH:MM' on `tz`; '' = left open. */
export function wallClockOf(plan: { checkInAt: Date; checkOutAt: Date | null }, tz: string): { checkIn: string; checkOut: string } {
  return { checkIn: hhmmIn(tz, plan.checkInAt), checkOut: plan.checkOutAt ? hhmmIn(tz, plan.checkOutAt) : '' };
}

/** The subset of the shared row a time-correction DTO is read from. */
export interface TimeCorrectionRow {
  _id: unknown;
  userId: string;
  name?: string;
  branch?: string;
  from: string;
  reason?: string;
  status: string;
  appliedAt?: Date | null;
  createdAt?: Date | null;
  decidedBy?: string | null;
  decidedAt?: Date | null;
  decisionNote?: string | null;
  checkIn?: string | null;
  checkOut?: string | null;
  chain?: ChainLevel[] | null;
  approvals?: ChainSignature[] | null;
}

/** The app's Regularization DTO — unchanged shape for the screens, now read off the shared row.
 *  `waitingOn` / `signedBy` are new and optional: where the ERP's chain stands on a pending row. */
export interface RegularizationDto {
  id: string;
  userId: string;
  date: string;
  checkInAt: string;
  checkOutAt: string | null;
  reason: string;
  status: string;
  appliedAt: string;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionNote: string;
  name?: string;
  branch?: string;
  waitingOn?: string;
  signedBy?: string[];
}

const iso = (d: Date | string | null | undefined): string | null => {
  if (!d) return null;
  const t = new Date(d);
  return Number.isFinite(t.getTime()) ? t.toISOString() : null;
};

/** Pure: the DTO for a shared row — HH:MM on `tz` back to instants (a malformed time reads as midnight
 *  rather than crashing a list; the ERP validated it on the way in). */
export function toRegularizationDto(row: TimeCorrectionRow, tz: string, extra: { name?: string; branch?: string } = {}): RegularizationDto {
  const inAt = instantAt(row.from, String(row.checkIn || ''), tz) ?? new Date(`${row.from}T00:00:00.000Z`);
  const outAt = row.checkOut ? instantAt(row.from, String(row.checkOut), tz) : null;
  const pending = row.status === 'pending';
  return {
    id: String(row._id),
    userId: String(row.userId),
    date: row.from,
    checkInAt: inAt.toISOString(),
    checkOutAt: outAt ? outAt.toISOString() : null,
    reason: String(row.reason ?? ''),
    status: row.status,
    appliedAt: iso(row.appliedAt ?? row.createdAt) ?? new Date(0).toISOString(),
    decidedBy: row.decidedBy ? String(row.decidedBy) : null,
    decidedAt: iso(row.decidedAt),
    decisionNote: String(row.decisionNote ?? ''),
    name: extra.name ?? (row.name || undefined),
    branch: extra.branch ?? (row.branch || undefined),
    ...(pending ? { waitingOn: waitingOn(row), signedBy: signedBy(row) } : {}),
  };
}
