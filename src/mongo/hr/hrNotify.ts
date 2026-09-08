import { Types } from 'mongoose';
import { crmRepo, type CrmUser } from '../crm.repo';
import { reportChat } from '../alerts/reportChat.service';
import { attendanceBranchCode } from '../attendance/attendanceBranch';
import { userWorkBranches } from '../attendance/userWorkBranches';

// Chat-room notifications for the HR self-service asks (leave applications, attendance
// regularisations). Same posture as the attendance punch lines: the post goes to the branch's
// HR room, falls back to the finance group when the branch has no HR room yet, and NEVER throws
// or blocks the write — callers fire it with `void`. Filing a request must not depend on being
// able to announce it.

export const nameOfUser = (u: CrmUser | null): string =>
  u ? `${u.first_name ?? ''} ${u.last_name ?? ''}`.trim() || u.email || 'Unknown' : 'Unknown';

/** The reporting branch code for a person: their HR-record branch code when it resolves, else the
 *  same rule the punch lines use (explicit working branch → first CRM branch). '' = no room. */
export async function hrBranchCodeFor(userId: string, preferCode?: string | null): Promise<string> {
  const direct = attendanceBranchCode({ code: String(preferCode ?? '').trim() || null });
  if (direct) return direct;
  const user = await crmRepo.getUserById(userId);
  if (!user) return '';
  const assigned = await userWorkBranches.branchIdFor(userId);
  const branchId = assigned ?? String((user.branch_ids ?? [])[0] ?? '');
  if (!Types.ObjectId.isValid(branchId)) return '';
  const [branch] = await crmRepo.branchesByIds([new Types.ObjectId(branchId)]);
  return attendanceBranchCode(branch ?? null);
}

/** Post into the branch's HR room, falling back to its finance group (same rule as the
 *  attendance punch lines — every branch has a finance group from day one). */
export async function postToBranchHrGroup(input: { branchCode: string; title: string; body?: string; dedupeKey?: string }): Promise<void> {
  try {
    try {
      await reportChat.post({ ...input, group: 'hr' });
    } catch (e) {
      if (!/^No hr group for branch/.test((e as Error).message)) throw e;
      await reportChat.post({ ...input, group: 'finance' });
    }
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(`[hr-chat] ${input.dedupeKey ?? input.title}: ${(e as Error).message}`);
  }
}
