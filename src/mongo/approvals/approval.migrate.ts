import { ApprovalModel, type LegacyApprovalDoc } from './approval.model';
import { levelsFromLegacySteps } from './approval.chain';

// One-time, idempotent boot migration: requests written before N-level chains carried
// `steps[]` (one approver per role step) + `currentStep`. Each step becomes a single-approver
// level with the same status/note, so open requests keep moving and decided ones read the same.
// Only touches kb360_app.approval_requests rows that still lack `levels`; a no-op afterwards.
const LEGACY_INDEX = 'steps.approverId_1_status_1_submittedAt_-1';

export async function migrateLegacyApprovalChains(): Promise<number> {
  const coll = ApprovalModel().collection;
  const legacy = (await coll.find({ levels: { $exists: false }, steps: { $exists: true } }).toArray()) as unknown as LegacyApprovalDoc[];
  for (const d of legacy) {
    await coll.updateOne(
      { _id: d._id, levels: { $exists: false } },
      { $set: { levels: levelsFromLegacySteps(d.steps ?? []), currentLevel: d.currentStep ?? 0 }, $unset: { steps: '', currentStep: '' } },
    );
  }
  try {
    await coll.dropIndex(LEGACY_INDEX);
  } catch {
    // not there (already dropped, or a fresh database) — nothing to do
  }
  if (legacy.length) {
    // eslint-disable-next-line no-console
    console.log(`[approvals] migrated ${legacy.length} legacy request(s) to levels`);
  }
  return legacy.length;
}
