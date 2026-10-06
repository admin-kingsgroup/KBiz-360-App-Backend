import { Types } from 'mongoose';
import { crmRepo, type CrmUser } from '../crm.repo';
import { alertService } from '../alerts/alert.service';
import { channelForModuleBranch } from '../alerts/alertChannels';
import { attendanceBranchCode } from '../attendance/attendanceBranch';
import { userWorkBranches } from '../attendance/userWorkBranches';

// Alert-channel notifications for the HR self-service asks (leave applications, time
// corrections). They land in the branch's HR alert channel — "HR - MHUB" in the app's Alerts
// section — next to the check-in / check-out lines and the 10 PM day-close summary, exactly
// where the attendance service posts (attendance.service postAttendanceAlert). Until 2026-10-06
// they posted into the branch's HR GROUP CHAT and fell back to its Finance group when the
// branch had no HR room, so MHUB's leave and time asks were landing in "MHUB - Finance Team";
// the owner: "these notifications related to HR should go to HR Alerts, not here in groups".
// HR is grant-only: supers plus the people a super-admin switches on in Team & Users.
//
// Same posture as the punch lines: NEVER throws and never blocks the write — callers fire it
// with `void`. Filing a request must not depend on being able to announce it.

export const nameOfUser = (u: CrmUser | null): string =>
  u ? `${u.first_name ?? ''} ${u.last_name ?? ''}`.trim() || u.email || 'Unknown' : 'Unknown';

/** The reporting branch code for a person: their HR-record branch code when it resolves, else the
 *  same rule the punch lines use (explicit working branch → first CRM branch). '' = no channel. */
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

export interface HrAlertInput {
  branchCode: string;
  title: string;
  body?: string;
  /** Idempotency key, unique per channel — a retried filing announces once. */
  dedupeKey?: string;
  /** The applicant: left out of the push fan-out (they filed it; the card is for the approvers). */
  actorUserId?: string | null;
  /** Card label; defaults to 'HR'. */
  source?: string;
}

/** Post into the branch's HR alert channel (tk_hr_<branch>). Resolves to the result for tests;
 *  a branch with no HR channel is a log warning, never an error. */
export async function postToBranchHrAlerts(input: HrAlertInput): Promise<{ posted: boolean; duplicate: boolean; channel: string }> {
  try {
    const channel = channelForModuleBranch('attendance', input.branchCode);
    if (!channel) throw new Error(`No HR alert channel for branch "${input.branchCode}"`);
    const { duplicate } = await alertService.record(channel.id, {
      source: input.source ?? 'HR',
      title: input.title,
      body: input.body ?? '',
      context: `TK ${channel.branchCode} · HR`,
    }, input.actorUserId ?? null, input.dedupeKey);
    return { posted: !duplicate, duplicate, channel: channel.name };
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(`[hr-alert] ${input.dedupeKey ?? input.title}: ${(e as Error).message}`);
    return { posted: false, duplicate: false, channel: '' };
  }
}
