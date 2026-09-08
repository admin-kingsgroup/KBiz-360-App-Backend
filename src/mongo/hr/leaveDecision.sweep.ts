import { appDb } from '../connection';
import { alertService } from '../alerts/alert.service';
import { hrRepo } from './hr.repo';

// Leave-decision push: HR decides leave applications on the ERP (/tk/hr-leave), which has no
// line to this backend — so this sweep polls the SHARED hr_leave_applications collection for
// fresh decisions and tells each applicant in My Alerts (with a push). The cursor (the last
// decidedAt seen) is persisted in kb360_app so a restart never re-announces old decisions,
// and starts a day back on first boot so nothing recent is missed.
//
// Decisions this backend makes itself (a self-service CANCEL) are excluded by status — only
// approved/rejected are announced.

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

export async function sweepLeaveDecisions(): Promise<number> {
  const since = await loadCursor();
  const rows = await hrRepo.leaveApplicationsDecidedSince(since);
  if (!rows.length) return 0;
  let latest = since;
  for (const app of rows) {
    const decidedAt = app.decidedAt ? new Date(app.decidedAt) : null;
    if (!decidedAt) continue;
    const span = app.from === app.to ? app.from : `${app.from} → ${app.to}`;
    const body = app.status === 'approved'
      ? `${span}${app.markedDays?.length ? ` · ${app.markedDays.length} day${app.markedDays.length === 1 ? '' : 's'} marked` : ''}${app.decisionNote ? ` · ${app.decisionNote}` : ''}`
      : `${span}${app.decisionNote ? ` · ${app.decisionNote}` : ''}`;
    try {
      await alertService.recordUserAlert(app.userId, {
        source: 'HR',
        title: `Leave ${app.status}`,
        body,
        context: 'Your leave',
      });
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
