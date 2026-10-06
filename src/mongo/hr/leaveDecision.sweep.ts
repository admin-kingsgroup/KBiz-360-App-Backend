import { appDb } from '../connection';
import { alertService } from '../alerts/alert.service';
import { hrRepo, type HrLeaveApplicationDoc } from './hr.repo';

// Decision push: HR decides leave applications AND time corrections on the ERP (Approvals ▸
// Leave), which has no line to this backend — so this sweep polls the SHARED
// hr_leave_applications collection for fresh decisions and tells each applicant in My Alerts
// (with a push). The cursor (the last decidedAt seen) is persisted in kb360_app so a restart
// never re-announces old decisions, and starts a day back on first boot so nothing recent is
// missed. A decision the Super Admin makes in the app lands on the same row and is announced by
// the same sweep (regularization.service runs it at once), so nobody is told twice.
//
// A self-service CANCEL is excluded by status — only approved/rejected are announced.

const SWEEP_MS = 60_000;
const FIRST_BOOT_LOOKBACK_MS = 24 * 3600_000;
const STATE_ID = 'leave-decision-cursor';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const stateCol = () => appDb().collection('hr_sweep_state') as any;

async function loadCursor(): Promise<Date> {
  const row = await stateCol().findOne({ _id: STATE_ID });
  const at = row?.decidedAt ? new Date(row.decidedAt) : null;
  return at && Number.isFinite(at.getTime()) ? at : new Date(Date.now() - FIRST_BOOT_LOOKBACK_MS);
}
async function saveCursor(at: Date): Promise<void> {
  await stateCol().updateOne({ _id: STATE_ID }, { $set: { decidedAt: at, updatedAt: new Date() } }, { upsert: true });
}

/** Pure: the alert a decided row earns, by kind (exported for tests). */
export function decisionAlert(app: Pick<HrLeaveApplicationDoc, 'kind' | 'status' | 'from' | 'to' | 'markedDays' | 'decisionNote' | 'checkIn' | 'checkOut' | 'toStatus'>): { source: string; title: string; body: string; context: string } {
  const note = app.decisionNote ? ` · ${app.decisionNote}` : '';
  if (app.kind === 'time') {
    const times = `in ${app.checkIn || '—'}${app.checkOut ? ` · out ${app.checkOut}` : ' · out left open'}`;
    return {
      source: 'Attendance',
      title: `Time correction ${app.status} · ${app.from}`,
      body: app.status === 'approved' ? `Your times for ${app.from} were applied (${times})${note}` : `${times}${note}`,
      context: 'Your attendance',
    };
  }
  if (app.kind === 'cancel') {
    return {
      source: 'HR',
      title: `Leave removal ${app.status} · ${app.from}`,
      body: app.status === 'approved' ? `${app.from} is no longer paid leave${app.toStatus ? ` — it is now ${app.toStatus}` : ''}${note}` : `${app.from}${note}`,
      context: 'Your leave',
    };
  }
  const span = app.from === app.to ? app.from : `${app.from} → ${app.to}`;
  return {
    source: 'HR',
    title: `Leave ${app.status}`,
    body: app.status === 'approved'
      ? `${span}${app.markedDays?.length ? ` · ${app.markedDays.length} day${app.markedDays.length === 1 ? '' : 's'} marked` : ''}${note}`
      : `${span}${note}`,
    context: 'Your leave',
  };
}

export async function sweepLeaveDecisions(): Promise<number> {
  const since = await loadCursor();
  const rows = await hrRepo.leaveApplicationsDecidedSince(since);
  if (!rows.length) return 0;
  let latest = since;
  for (const app of rows) {
    const decidedAt = app.decidedAt ? new Date(app.decidedAt) : null;
    if (!decidedAt) continue;
    const { title, body, context, source } = decisionAlert(app);
    try {
      await alertService.recordUserAlert(app.userId, { source, title, body, context });
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(`[leave-sweep] alert for ${app.userId} failed: ${(e as Error).message}`);
    }
    if (decidedAt.getTime() > latest.getTime()) latest = decidedAt;
  }
  if (latest.getTime() > since.getTime()) await saveCursor(latest);
  return rows.length;
}

let timer: ReturnType<typeof setInterval> | null = null;

export function startLeaveDecisionSweep(): void {
  if (timer) return;
  timer = setInterval(() => {
    void sweepLeaveDecisions().catch((e) => {
      // eslint-disable-next-line no-console
      console.warn(`[leave-sweep] ${(e as Error).message}`);
    });
  }, SWEEP_MS);
}

export function stopLeaveDecisionSweep(): void {
  if (timer) { clearInterval(timer); timer = null; }
}
