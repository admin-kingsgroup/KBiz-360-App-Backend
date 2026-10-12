import { isWeekOffDay, type WeekOffPolicy } from './attendanceMonth';
import { spanDays } from './leaveRules';
import { chainOf, signedBy, waitingOn, type ChainDoc } from './timeCorrection.rules';
import type { HrLeaveApplicationDoc } from './hr.repo';

// WORK FROM HOME and the SATURDAY SWAP (owner, 2026-10-12) — the pure half. Both are rows of the ERP's
// hr_leave_applications (kind 'wfh' / 'swap'), signed FM → Director → Owner on the ERP; a swap is accepted by the
// partner in this app first (the ERP's LEAVE-GATE-07). `swapProblem` is the 2nd copy of the ERP's
// leaveApplication.service.swapProblem — change both together. The ERP checks it again at the Owner's signature.

export const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
export const isSaturday = (day: string): boolean => new Date(`${day}T00:00:00Z`).getUTCDay() === 6;
const shift = (day: string, n: number): string => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/** A person as the swap check reads them: their name, their week-off rule, what is already decided on the days. */
export interface SwapSide { name: string; offByRule: (day: string) => boolean; overrides: Map<string, string> }

/** One side from an HR record's week-off policy + the day decisions that bear on it. */
export const sideOf = (name: string, policy: WeekOffPolicy | null | undefined, overrides: Map<string, string> = new Map()): SwapSide => ({
  name, offByRule: (day) => isWeekOffDay(day, policy ?? undefined), overrides,
});

const OVERRIDE_LABEL: Record<string, string> = { weekOff: 'a week off', optionalHoliday: 'an optional holiday', leave: 'paid leave', halfLeave: 'half-day leave', wfh: 'work from home', swapWork: 'another swap', swapOff: 'another swap' };

/** Pure: why this swap cannot stand — '' when it can (the ERP's swapProblem, verbatim).
 *  workDay = the applicant's OWN week-off Saturday they will work; offDay = their working Saturday they take off. */
export function swapProblem({ workDay, offDay, mine, theirs, today = '' }: { workDay: string; offDay: string; mine: SwapSide; theirs: SwapSide; today?: string }): string {
  if (!DAY_RE.test(String(workDay || '')) || !DAY_RE.test(String(offDay || ''))) return 'Pick both Saturdays';
  if (workDay === offDay) return 'Pick two different Saturdays';
  if (!isSaturday(workDay) || !isSaturday(offDay)) return 'A swap trades Saturdays — both days must be Saturdays';
  if (today && (workDay < today || offDay < today)) return 'A swap is arranged ahead — both Saturdays must be today or later';
  const nameOf = (p: SwapSide): string => p.name || 'they';
  for (const [p, d] of [[mine, workDay], [mine, offDay], [theirs, workDay], [theirs, offDay]] as [SwapSide, string][]) {
    const st = p.overrides.get(d);
    if (st) return `${nameOf(p)} already has ${OVERRIDE_LABEL[st] ?? st} on ${d} — a day already decided is not swapped`;
  }
  if (!mine.offByRule(workDay)) return `${workDay} is not ${nameOf(mine)}'s week off — the Saturday worked must be one of their own week-off Saturdays`;
  if (mine.offByRule(offDay)) return `${offDay} is already ${nameOf(mine)}'s week off — the Saturday taken off must be one they work`;
  if (theirs.offByRule(workDay)) return `${nameOf(theirs)} is off on ${workDay} too — the partner must work that Saturday`;
  if (!theirs.offByRule(offDay)) return `${offDay} is not ${nameOf(theirs)}'s week off — the partner must be off that Saturday`;
  return '';
}

/** Pure: the next `n` Saturdays from `today` (today included when it is one). */
export function upcomingSaturdays(today: string, n = 12): string[] {
  let d = today;
  while (!isSaturday(d)) d = shift(d, 1);
  return Array.from({ length: n }, (_, i) => shift(d, i * 7));
}

/** Pure: only an alternate-Saturday rule has both kinds of Saturday to trade. */
export const swapRuleOf = (policy: WeekOffPolicy | null | undefined): 'none' | 'all' | 'odd' | 'even' => {
  const r = String(policy?.saturdays ?? 'none');
  return r === 'all' || r === 'odd' || r === 'even' ? r : 'none';
};

/** Pure: the open swaps on these days as day decisions for the check — a Saturday already in a swap (pending or
 *  approved) reads like 'another swap' for both people in it. */
export function swapBusyByPerson(open: Pick<HrLeaveApplicationDoc, 'userId' | 'swap' | '_id'>[], exceptId = ''): Map<string, Map<string, string>> {
  const out = new Map<string, Map<string, string>>();
  const mark = (uid: string, day: string, st: string): void => {
    if (!uid || !day) return;
    if (!out.has(uid)) out.set(uid, new Map());
    (out.get(uid) as Map<string, string>).set(day, st);
  };
  for (const a of open) {
    if (exceptId && String(a._id) === exceptId) continue;
    const sw = a.swap;
    if (!sw) continue;
    mark(String(a.userId), sw.workDay, 'swapWork');
    mark(String(a.userId), sw.offDay, 'swapOff');
    mark(String(sw.partnerUserId), sw.workDay, 'swapOff');
    mark(String(sw.partnerUserId), sw.offDay, 'swapWork');
  }
  return out;
}

/** Pure: merge day-decision maps (overrides first, then open swaps). */
export const mergeDayMaps = (...maps: (Map<string, string> | undefined)[]): Map<string, string> => {
  const out = new Map<string, string>();
  for (const m of maps) if (m) for (const [k, v] of m) if (!out.has(k)) out.set(k, v);
  return out;
};

const iso = (d: Date | string | null | undefined): string | null => (d ? new Date(d).toISOString() : null);

export interface WfhApplicationDto {
  id: string; from: string; to: string; days: number; reason: string;
  status: string; appliedAt: string | null; decidedAt: string | null; decisionNote: string; decidedRole: string;
  markedDays: string[]; skippedDays: { day: string; reason: string }[];
  waitingOn: string; signedBy: string[];
}

export function toWfhDto(doc: HrLeaveApplicationDoc): WfhApplicationDto {
  return {
    id: String(doc._id), from: doc.from, to: doc.to, days: spanDays(doc.from, doc.to).length, reason: doc.reason,
    status: doc.status, appliedAt: iso(doc.appliedAt), decidedAt: iso(doc.decidedAt), decisionNote: doc.decisionNote ?? '', decidedRole: doc.decidedRole ?? '',
    markedDays: doc.markedDays ?? [], skippedDays: doc.skippedDays ?? [],
    waitingOn: doc.status === 'pending' ? waitingOn(doc as ChainDoc) : '',
    signedBy: signedBy(doc as ChainDoc),
  };
}

export interface SwapRequestDto {
  id: string; role: 'applicant' | 'partner';
  workDay: string; offDay: string;
  applicant: { userId: string; name: string }; partner: { userId: string; name: string };
  partnerStatus: 'pending' | 'accepted' | 'declined'; partnerAt: string | null; partnerNote: string;
  reason: string; status: string; appliedAt: string | null; decidedAt: string | null; decisionNote: string; decidedRole: string;
  waitingOn: string; signedBy: string[];
  you: { work: string; off: string };
}

/** Pure: who the swap waits on — the partner before anyone in the chain (the ERP's waitingOn). */
export function swapWaitingOn(doc: HrLeaveApplicationDoc): string {
  if (doc.status !== 'pending') return '';
  if (!doc.swap || doc.swap.partnerStatus !== 'accepted') return `${doc.swap?.partnerName || 'The partner'} (swap partner)`;
  return waitingOn({ chain: chainOf(doc as ChainDoc), approvals: doc.approvals ?? [] });
}

/** Pure: a swap row as `viewerId` reads it — their side and their own two days. */
export function toSwapDto(doc: HrLeaveApplicationDoc, viewerId: string): SwapRequestDto {
  const sw = doc.swap ?? { workDay: '', offDay: '', partnerUserId: '', partnerName: '', partnerBranch: '', partnerStatus: 'pending', partnerAt: null, partnerNote: '' };
  const role: 'applicant' | 'partner' = String(doc.userId) === String(viewerId) ? 'applicant' : 'partner';
  return {
    id: String(doc._id), role,
    workDay: sw.workDay, offDay: sw.offDay,
    applicant: { userId: String(doc.userId), name: doc.name || '' },
    partner: { userId: String(sw.partnerUserId || ''), name: sw.partnerName || '' },
    partnerStatus: sw.partnerStatus === 'accepted' || sw.partnerStatus === 'declined' ? sw.partnerStatus : 'pending',
    partnerAt: iso(sw.partnerAt), partnerNote: sw.partnerNote || '',
    reason: doc.reason, status: doc.status, appliedAt: iso(doc.appliedAt), decidedAt: iso(doc.decidedAt),
    decisionNote: doc.decisionNote ?? '', decidedRole: doc.decidedRole ?? '',
    waitingOn: swapWaitingOn(doc), signedBy: signedBy(doc as ChainDoc),
    you: role === 'applicant' ? { work: sw.workDay, off: sw.offDay } : { work: sw.offDay, off: sw.workDay },
  };
}

/** 'Sat 17 Oct' — for alert text (UTC on the key, so no day ever slides). */
export function satLabel(day: string): string {
  if (!DAY_RE.test(day)) return day;
  const d = new Date(`${day}T00:00:00Z`);
  return `${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getUTCDay()]} ${d.getUTCDate()} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()]}`;
}
