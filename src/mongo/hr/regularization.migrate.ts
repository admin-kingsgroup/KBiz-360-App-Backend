import { appDb } from '../connection';
import { crmRepo } from '../crm.repo';
import { hrRepo } from './hr.repo';
import { hrBranchCodeFor, nameOfUser } from './hrNotify';
import { clockForPerson } from './regularization.service';
import { freshChain, hhmmIn, LEAVE_CHAIN, OWNER_ROLE } from './timeCorrection.rules';

// ONE-TIME: the app-owned `attendance_regularizations` rows (every time correction asked before
// 2026-10-06) move into the shared hr_leave_applications queue as kind 'time', so a request still
// waiting shows up on the ERP's Approvals ▸ Leave and nothing already decided drops off the app's
// Approved / Rejected tabs. Idempotent: a moved row is stamped `migratedTo` and never read again;
// a crash mid-way resumes where it stopped. Runs at boot after the indexes (mongo/main.ts).

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const legacyCol = () => appDb().collection('attendance_regularizations') as any;

const SIGN_PAST_REASON = 'Decided in the Smart Connect app before the shared queue (migrated 2026-10-06)';

interface LegacyRow {
  _id: unknown;
  userId: string;
  dateKey: string;
  checkInAt: Date;
  checkOutAt: Date | null;
  reason: string;
  status: string;
  appliedAt?: Date;
  decidedBy?: string | null;
  decidedAt?: Date | null;
  decisionNote?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

export async function migrateRegularizationsToSharedQueue(): Promise<number> {
  const rows = (await legacyCol().find({ migratedTo: { $exists: false } }).sort({ appliedAt: 1 }).toArray()) as LegacyRow[];
  let moved = 0;
  for (const r of rows) {
    try {
      const user = await crmRepo.getUserById(String(r.userId));
      const emp = await hrRepo.employeeByUserId(String(r.userId));
      const branch = String(emp?.branch ?? '').trim().toUpperCase() || (await hrBranchCodeFor(String(r.userId)));
      const tz = await clockForPerson(String(r.userId), emp);
      const decidedAt = r.decidedAt ? new Date(r.decidedAt) : null;
      const decidedBy = String(r.decidedBy ?? '');
      const status = ['pending', 'approved', 'rejected', 'cancelled'].includes(r.status) ? r.status : 'pending';
      const approvals = status === 'approved' && decidedAt
        ? [
          ...LEAVE_CHAIN.filter((l) => l.role !== OWNER_ROLE).map((l) => ({ role: l.role, by: decidedBy, at: decidedAt, skipped: true, signedPastBy: OWNER_ROLE, reason: SIGN_PAST_REASON })),
          { role: OWNER_ROLE, by: decidedBy, at: decidedAt, note: String(r.decisionNote ?? '') },
        ]
        : [];
      const appliedAt = r.appliedAt ? new Date(r.appliedAt) : (r.createdAt ? new Date(r.createdAt) : new Date());
      const doc = await hrRepo.insertLeaveApplication({
        userId: String(r.userId),
        name: String(emp?.name ?? '').trim() || nameOfUser(user),
        branch,
        from: r.dateKey,
        to: r.dateKey,
        dayType: 'full',
        reason: String(r.reason ?? ''),
        status: status as 'pending' | 'approved' | 'rejected' | 'cancelled',
        appliedAt,
        decidedBy,
        decidedAt,
        decisionNote: String(r.decisionNote ?? ''),
        markedDays: status === 'approved' ? [r.dateKey] : [],
        skippedDays: [],
        chain: freshChain(),
        approvals,
        source: 'self',
        kind: 'time',
        toStatus: '',
        checkIn: hhmmIn(tz, new Date(r.checkInAt)),
        checkOut: r.checkOutAt ? hhmmIn(tz, new Date(r.checkOutAt)) : '',
        raisedBy: { userId: '', name: '', role: '' },
        createdAt: r.createdAt ? new Date(r.createdAt) : appliedAt,
        updatedAt: new Date(),
        __v: 0,
      });
      await legacyCol().updateOne({ _id: r._id }, { $set: { migratedTo: String(doc._id), migratedAt: new Date() } });
      moved += 1;
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(`[hr] time correction ${String(r._id)} not migrated: ${(e as Error).message}`);
    }
  }
  if (moved) {
    // eslint-disable-next-line no-console
    console.log(`[hr] migrated ${moved} time correction(s) into the shared hr_leave_applications queue`);
  }
  return moved;
}
