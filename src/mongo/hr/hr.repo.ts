import { Types } from 'mongoose';
import { crmDb, crmWriteDb } from '../connection';
import { guardReadOnly } from '../crm.repo';

// HR collections live in the CRM/ERP database (same db as users/branches) — the ERP owns the
// HR SEMANTICS (Employee Master, leave approvals at /tk/hr-leave, attendance overrides). This app
// READS them for self-service display, and performs a short list of sanctioned writes, all on
// hr_leave_applications: filing the signed-in person's own application (status 'pending' — only
// an approval ever touches attendance or the balance), withdrawing it while still pending, and —
// since 2026-10-06 — filing and deciding a TIME CORRECTION (kind 'time'), the row the ERP's own
// "Correct time" files, so the ERP's Approvals ▸ Leave and the app's Time-corrections queue read
// ONE row (timeCorrection.rules). Everything else stays read-only-guarded like crm.repo.

export interface HrEmployeeDoc {
  _id: Types.ObjectId;
  userId?: string; // the shared `users` _id as a STRING ('' = no login linked)
  empCode?: string;
  name?: string;
  designation?: string;
  department?: string;
  gender?: string; // male | female | other (drives the PT ladder)
  branch?: string; // UPPERCASE branch code (e.g. 'BOM'), not an id
  dateOfJoining?: string; // 'YYYY-MM-DD'
  dateOfLeaving?: string;
  status?: string; // 'active' | 'inactive' (the active flag — there is no boolean)
  leave?: { openingBalance?: number; openingAsOf?: string; monthlyAccrual?: number | null };
  weekOff?: { days?: number[]; saturdays?: string }; // weekly-off policy (absent → Sunday only)
  shift?: { start?: string; end?: string; graceMinutes?: number }; // '' = office default, no late marks
  salary?: { basic?: number; hra?: number; otherAllowance?: number; effectiveFrom?: string };
  tds?: { applicable?: boolean; monthly?: number; note?: string };
  pt?: { mode?: string; state?: string; manualMonthly?: number };
  payment?: { mode?: string; bankName?: string; accountNo?: string; ifsc?: string; upi?: string };
}

export interface HrOverrideDoc {
  userId: string;
  day: string; // 'YYYY-MM-DD'
  state: string; // 'weekOff' | 'optionalHoliday' | 'leave' | 'halfLeave' | 'wfh' | 'swapWork' | 'swapOff'
  note?: string;
}

export interface HolidayEntry {
  date: string; // 'YYYY-MM-DD'
  name: string;
  kind: 'closed' | 'optional';
  movable?: boolean;
}

export interface HolidayListDoc {
  country: string;
  year: number;
  title?: string;
  company?: string;
  issuedBy?: string;
  issuedOn?: string;
  notes?: string[];
  holidays: HolidayEntry[];
}

export interface HrStaffLoanDoc {
  _id: Types.ObjectId;
  userId?: string;
  kind?: string; // loan | advance
  reference?: string;
  principal?: number;
  instalment?: number;
  openingRecovered?: number;
  waived?: number;
  startMonth?: string; // 'YYYY-MM'
  endMonth?: string;
  skipMonths?: string[];
  status?: string; // active | paused | closed
}

export type LeaveApplicationStatus = 'pending' | 'approved' | 'rejected' | 'cancelled';

export interface HrLeaveApplicationDoc {
  _id: Types.ObjectId;
  userId: string;
  name: string; // display name when applied (denormalised, like the ERP writes)
  branch: string; // owner branch code when applied (the ERP queue's filter)
  from: string; // 'YYYY-MM-DD' business-tz day keys
  to: string;
  dayType?: string; // 'full' | 'half' (half = one day, the other half worked; absent = full)
  reason: string;
  status: LeaveApplicationStatus;
  appliedAt: Date;
  decidedBy: string;
  decidedAt: Date | null;
  decisionNote: string;
  markedDays: string[]; // filled by the ERP on approval
  skippedDays: { day: string; reason: string }[];
  // THE CHAIN and the KINDS the ERP added 2026-10-05 (leaveApplication.model) — mirrored so a row
  // this app files reads exactly like one the ERP files. `chain` FM → Director → Owner; `approvals`
  // the signatures (a level signed past carries `skipped` + why). `kind` 'leave' (default) | 'time'
  // (a time correction: `checkIn` / `checkOut` 'HH:MM' on the person's branch clock, from === to) |
  // 'cancel' (a leave removal raised on the ERP sheet). `source` 'self' | 'sheet'.
  chain?: { order: number; role: string; label: string }[];
  approvals?: { role: string; by: string; at: Date; note?: string; skipped?: boolean; signedPastBy?: string; reason?: string }[];
  source?: string;
  kind?: string;
  toStatus?: string;
  checkIn?: string;
  checkOut?: string;
  raisedBy?: { userId: string; name: string; role: string };
  decidedRole?: string; // the chain level that rejected it — 'Partner' when a swap's partner declined
  // kind 'swap' (owner, 2026-10-12 — the ERP's leaveApplication.model): workDay = the applicant's own week-off
  // Saturday they work (the partner is off), offDay = the applicant's working Saturday they take off (the partner
  // works). The partner accepts in the app first, then FM → Director → Owner sign on the ERP.
  swap?: HrSwapSide;
  __v?: number; // the ERP model uses optimistic concurrency — a row without it still saves, but 0 is what it writes
  createdAt?: Date;
  updatedAt?: Date;
}

export interface HrSwapSide {
  workDay: string;
  offDay: string;
  partnerUserId: string;
  partnerName: string;
  partnerBranch: string;
  partnerStatus: 'pending' | 'accepted' | 'declined';
  partnerAt: Date | null;
  partnerNote: string;
}

export type LeaveApplicationKind = 'leave' | 'time' | 'cancel' | 'wfh' | 'swap';
/** Leave only — a time correction, a leave removal, work from home or a Saturday swap is not paid leave (the
 *  ERP's NOT_LEAVE_KINDS). */
const LEAVE_KINDS_ONLY = { kind: { $nin: ['time', 'cancel', 'wfh', 'swap'] } };
/** The asks that take a working day: paid leave and work from home clash with each other (one ask per day —
 *  the ERP's NO_DAY_CLASH_KINDS). */
const DAY_ASK_KINDS = { kind: { $nin: ['time', 'cancel', 'swap'] } };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const col = (name: string) => guardReadOnly(crmDb().collection(name)) as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const writeCol = (name: string) => crmWriteDb().collection(name) as any;

export const hrRepo = {
  /** The HR record linked to a login ('' userId records never match). */
  async employeeByUserId(userId: string): Promise<HrEmployeeDoc | null> {
    if (!userId) return null;
    return col('hr_employees').findOne({ userId: String(userId) }) as Promise<HrEmployeeDoc | null>;
  },

  /** The person's recorded paid-leave overrides (state 'leave' | 'halfLeave') — all time;
   *  the month windowing happens inside leaveBalance, the weighing in leave.service. */
  async leaveOverrides(userId: string): Promise<{ day: string; state: string }[]> {
    if (!userId) return [];
    const rows = (await col('hr_attendance_overrides')
      .find({ userId: String(userId), state: { $in: ['leave', 'halfLeave'] } }, { projection: { day: 1, state: 1 } })
      .toArray()) as { day?: string; state?: string }[];
    return rows.map((r) => ({ day: String(r.day ?? ''), state: String(r.state ?? 'leave') })).filter((r) => !!r.day);
  },

  /** HR's one-off day decisions inside [from..to] (weekOff / optionalHoliday / leave). */
  async overridesForRange(userId: string, from: string, to: string): Promise<HrOverrideDoc[]> {
    if (!userId) return [];
    return col('hr_attendance_overrides')
      .find({ userId: String(userId), day: { $gte: from, $lte: to } }, { projection: { userId: 1, day: 1, state: 1, note: 1 } })
      .toArray() as Promise<HrOverrideDoc[]>;
  },

  /** The published holiday list for a country + year (ERP master `holidaylists`; null = none). */
  async holidayList(country: string, year: number): Promise<HolidayListDoc | null> {
    const c = String(country || '').toUpperCase();
    if (!/^[A-Z]{2}$/.test(c) || !Number.isInteger(year)) return null;
    return col('holidaylists').findOne({ country: c, year }) as Promise<HolidayListDoc | null>;
  },

  /** A branch code's holiday country ('' when the branch/country is unknown). */
  async branchCountry(code: string): Promise<string> {
    const c = String(code || '').trim().toUpperCase();
    if (!c) return '';
    const row = (await col('branches').findOne({ code: c }, { projection: { countryCode: 1, country: 1 } })) as { countryCode?: string } | null;
    return row ? String(row.countryCode || '').toUpperCase() : '';
  },

  /** The person's staff loans (any state — the schedule decides what a month recovers). */
  async staffLoansFor(userId: string): Promise<HrStaffLoanDoc[]> {
    if (!userId) return [];
    return col('hr_staff_loans').find({ userId: String(userId) }).toArray() as Promise<HrStaffLoanDoc[]>;
  },

  /** Leave applications decided AFTER `since` (the decision-push sweep's read). */
  async leaveApplicationsDecidedSince(since: Date, limit = 100): Promise<HrLeaveApplicationDoc[]> {
    return col('hr_leave_applications')
      .find({ status: { $in: ['approved', 'rejected'] }, decidedAt: { $gt: since } })
      .sort({ decidedAt: 1 })
      .limit(limit)
      .toArray() as Promise<HrLeaveApplicationDoc[]>;
  },

  /** The person's LEAVE applications (any status) — time corrections live on their own trail. */
  async listLeaveApplications(userId: string, limit = 50): Promise<HrLeaveApplicationDoc[]> {
    return col('hr_leave_applications')
      .find({ userId: String(userId), ...LEAVE_KINDS_ONLY })
      .sort({ appliedAt: -1 })
      .limit(limit)
      .toArray() as Promise<HrLeaveApplicationDoc[]>;
  },

  /** Spans that already claim days — paid leave and work from home (one ask per day — pending AND approved
   *  both block; an approved one only on the days it actually marked, like the ERP's assertNoOverlap). */
  async openLeaveApplications(userId: string): Promise<Pick<HrLeaveApplicationDoc, 'from' | 'to' | 'status' | 'markedDays' | 'kind'>[]> {
    return col('hr_leave_applications')
      .find({ userId: String(userId), status: { $in: ['pending', 'approved'] }, ...DAY_ASK_KINDS }, { projection: { from: 1, to: 1, status: 1, markedDays: 1, kind: 1 } })
      .toArray() as Promise<Pick<HrLeaveApplicationDoc, 'from' | 'to' | 'status' | 'markedDays' | 'kind'>[]>;
  },

  // ── work from home + Saturday swaps (owner, 2026-10-12) ──

  /** The person's own work-from-home trail, newest first. */
  async listWfh(userId: string, limit = 50): Promise<HrLeaveApplicationDoc[]> {
    return col('hr_leave_applications').find({ userId: String(userId), kind: 'wfh' }).sort({ appliedAt: -1 }).limit(limit).toArray() as Promise<HrLeaveApplicationDoc[]>;
  },

  /** Swaps the person asked for (applicant) and swaps asked OF them (partner), newest first. */
  async listSwaps(userId: string, limit = 50): Promise<{ mine: HrLeaveApplicationDoc[]; incoming: HrLeaveApplicationDoc[] }> {
    const [mine, incoming] = await Promise.all([
      col('hr_leave_applications').find({ userId: String(userId), kind: 'swap' }).sort({ appliedAt: -1 }).limit(limit).toArray(),
      col('hr_leave_applications').find({ kind: 'swap', 'swap.partnerUserId': String(userId) }).sort({ appliedAt: -1 }).limit(limit).toArray(),
    ]);
    return { mine: mine as HrLeaveApplicationDoc[], incoming: incoming as HrLeaveApplicationDoc[] };
  },

  /** Swaps still open (pending / approved) that involve any of these people on any of these days — a Saturday is
   *  in one swap at a time. */
  async openSwapsTouching(userIds: string[], days: string[]): Promise<HrLeaveApplicationDoc[]> {
    const ids = [...new Set(userIds.map(String).filter(Boolean))];
    if (!ids.length || !days.length) return [];
    return col('hr_leave_applications').find({
      kind: 'swap',
      status: { $in: ['pending', 'approved'] },
      $and: [
        { $or: [{ userId: { $in: ids } }, { 'swap.partnerUserId': { $in: ids } }] },
        { $or: [{ 'swap.workDay': { $in: days } }, { 'swap.offDay': { $in: days } }] },
      ],
    }).toArray() as Promise<HrLeaveApplicationDoc[]>;
  },

  /** The HR decisions on these days for these people (the swap check reads both sides at once). */
  async overridesOn(userIds: string[], days: string[]): Promise<HrOverrideDoc[]> {
    const ids = [...new Set(userIds.map(String).filter(Boolean))];
    if (!ids.length || !days.length) return [];
    return col('hr_attendance_overrides')
      .find({ userId: { $in: ids }, day: { $in: days } }, { projection: { userId: 1, day: 1, state: 1, note: 1 } })
      .toArray() as Promise<HrOverrideDoc[]>;
  },

  /** The branch's HR records linked to a login, not marked inactive — the people a swap may be asked of. */
  async employeesOfBranch(branch: string): Promise<HrEmployeeDoc[]> {
    const code = String(branch || '').trim().toUpperCase();
    if (!code) return [];
    return col('hr_employees')
      .find({ branch: code, userId: { $nin: [null, ''] }, status: { $ne: 'inactive' } }, { projection: { userId: 1, name: 1, designation: 1, branch: 1, weekOff: 1, dateOfJoining: 1, dateOfLeaving: 1, status: 1 } })
      .toArray() as Promise<HrEmployeeDoc[]>;
  },

  /** The partner answers a swap — only while it waits on them (atomic: a withdrawal or a second tap loses). */
  async answerSwap(id: string, partnerUserId: string, set: Record<string, unknown>): Promise<boolean> {
    if (!Types.ObjectId.isValid(id)) return false;
    const res = await writeCol('hr_leave_applications').updateOne(
      { _id: new Types.ObjectId(id), kind: 'swap', status: 'pending', 'swap.partnerUserId': String(partnerUserId), 'swap.partnerStatus': 'pending' },
      { $set: { ...set, updatedAt: new Date() }, $inc: { __v: 1 } },
    );
    return res.modifiedCount === 1;
  },

  // ── time corrections (kind 'time' — the row the ERP's Approvals ▸ Leave decides too) ──

  /** The person's own time-correction trail, newest first. */
  async listTimeCorrections(userId: string, limit = 50): Promise<HrLeaveApplicationDoc[]> {
    return col('hr_leave_applications')
      .find({ userId: String(userId), kind: 'time' })
      .sort({ appliedAt: -1 })
      .limit(limit)
      .toArray() as Promise<HrLeaveApplicationDoc[]>;
  },

  /** A correction for this day still waiting — one pending ask per day (the ERP's rule too). */
  async pendingTimeCorrection(userId: string, day: string): Promise<HrLeaveApplicationDoc | null> {
    return col('hr_leave_applications').findOne({ userId: String(userId), kind: 'time', status: 'pending', from: day }) as Promise<HrLeaveApplicationDoc | null>;
  },

  /** The Super Admin's queue in one state — pending oldest-first (longest wait on top), decided newest-decided first. */
  async timeCorrectionsByStatus(status: 'pending' | 'approved' | 'rejected', limit = 200): Promise<HrLeaveApplicationDoc[]> {
    const sort = status === 'pending' ? { appliedAt: 1 } : { decidedAt: -1 };
    return col('hr_leave_applications').find({ kind: 'time', status }).sort(sort).limit(limit).toArray() as Promise<HrLeaveApplicationDoc[]>;
  },

  async getTimeCorrection(id: string): Promise<HrLeaveApplicationDoc | null> {
    if (!Types.ObjectId.isValid(id)) return null;
    return col('hr_leave_applications').findOne({ _id: new Types.ObjectId(id), kind: 'time' }) as Promise<HrLeaveApplicationDoc | null>;
  },

  /** The branch master row's clock fields ('' when unknown) — the ERP keys a correction on the branch clock. */
  async branchRow(code: string): Promise<{ timezone: string; countryCode: string } | null> {
    const c = String(code || '').trim().toUpperCase();
    if (!c) return null;
    const row = (await col('branches').findOne({ code: c }, { projection: { timezone: 1, countryCode: 1 } })) as { timezone?: string; countryCode?: string } | null;
    return row ? { timezone: String(row.timezone || ''), countryCode: String(row.countryCode || '').toUpperCase() } : null;
  },

  /** Which of these logins have an HR record (the ERP reads a correction's clock off the record's branch). */
  async userIdsWithHrRecord(userIds: string[]): Promise<Set<string>> {
    const ids = [...new Set(userIds.map(String).filter(Boolean))];
    if (!ids.length) return new Set();
    const rows = (await col('hr_employees').find({ userId: { $in: ids } }, { projection: { userId: 1 } }).toArray()) as { userId?: string }[];
    return new Set(rows.map((r) => String(r.userId ?? '')).filter(Boolean));
  },

  async getLeaveApplication(id: string): Promise<HrLeaveApplicationDoc | null> {
    if (!Types.ObjectId.isValid(id)) return null;
    return col('hr_leave_applications').findOne({ _id: new Types.ObjectId(id) }) as Promise<HrLeaveApplicationDoc | null>;
  },

  // ── sanctioned writes (self-service only — the ERP alone approves/rejects) ──

  /** File the person's own application (status 'pending'). Shape mirrors the ERP's mongoose
   *  model exactly, timestamps included, so both queues read the same rows. */
  async insertLeaveApplication(doc: Omit<HrLeaveApplicationDoc, '_id'>): Promise<HrLeaveApplicationDoc> {
    const res = await writeCol('hr_leave_applications').insertOne(doc);
    return writeCol('hr_leave_applications').findOne({ _id: res.insertedId }) as Promise<HrLeaveApplicationDoc>;
  },

  /** Withdraw the person's OWN application while still pending. True = it was withdrawn. Only what
   *  the person asked for themselves: a row HR raised on the ERP sheet (source 'sheet') is HR's. */
  async cancelLeaveApplication(id: string, userId: string): Promise<boolean> {
    if (!Types.ObjectId.isValid(id)) return false;
    const now = new Date();
    const res = await writeCol('hr_leave_applications').updateOne(
      { _id: new Types.ObjectId(id), userId: String(userId), status: 'pending', source: { $in: [null, 'self'] } },
      { $set: { status: 'cancelled', decidedAt: now, updatedAt: now }, $inc: { __v: 1 } },
    );
    return res.modifiedCount === 1;
  },

  /** Decide a PENDING time correction atomically — the status guard means two decisions (the ERP's
   *  and the app's, or two taps) cannot both land; false = it was no longer pending. `$inc __v`
   *  keeps the ERP's optimistic-concurrency check honest for a signature made from a stale copy. */
  async decideTimeCorrection(
    id: string,
    set: Record<string, unknown>,
    approvals: HrLeaveApplicationDoc['approvals'],
  ): Promise<boolean> {
    if (!Types.ObjectId.isValid(id)) return false;
    const res = await writeCol('hr_leave_applications').updateOne(
      { _id: new Types.ObjectId(id), kind: 'time', status: 'pending' },
      { $set: { ...set, updatedAt: new Date() }, $push: { approvals: { $each: approvals ?? [] } }, $inc: { __v: 1 } },
    );
    return res.modifiedCount === 1;
  },
};
