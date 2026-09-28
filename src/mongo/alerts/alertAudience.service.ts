import { Types } from 'mongoose';
import { crmRepo } from '../crm.repo';
import { directoryService } from '../directory.service';
import type { MongoAccess } from '../access';
import { BadRequest, NotFound } from '../../common/errors';
import { ALERT_CHANNELS, canonicalBranchCode, needsErpAccess, type AlertChannelDef } from './alertChannels';
import { alertGrants, branchCodesByUser } from './alertGrants';
import { erpAccessIds } from './erpAccess';

// "Who sees this" for ONE alert channel (owner, 2026-09-28: "give an option so that I can decide
// which alert is visible to which user"). Super-admin screen, opened from the channel itself: it
// lists everyone who can sign in to the app AND belongs to the channel's branch (or hub), with the
// reason they do or don't see it, and a switch where a switch can decide it.
//   super   — super-admin: sees every channel, no switch
//   branch  — CRM / CRM Reports: everyone in the branch sees it, no switch
//   on/off  — HR / ERP / ERP Reports: the switch decides (the same grant as Team & Users 🔔)
//   no-erp  — ERP / ERP Reports for someone without ERP access: never sees it, no switch
// People outside the branch are not listed — nothing can show them this channel.
export type AudienceWhy = 'super' | 'branch' | 'on' | 'off' | 'no-erp';

export interface AudiencePerson {
  id: string;
  name: string;
  email: string;
  role: string;
  isSuper: boolean;
  codes: string[] | null; // branch codes; null = company-wide role
  hasErp: boolean;
  stored: string[]; // the user's stored grants
}

export interface AudienceRow {
  id: string;
  name: string;
  email: string;
  role: string;
  why: AudienceWhy;
  canToggle: boolean;
}

// Stable order — supers, then the branch by name (a switch never makes its row jump), then the
// people ERP access keeps out.
const ORDER: Record<AudienceWhy, number> = { super: 0, branch: 1, on: 1, off: 1, 'no-erp': 2 };

export function buildChannelAudience(channel: AlertChannelDef, people: AudiencePerson[]): AudienceRow[] {
  const erpOnly = needsErpAccess(channel.grant);
  const rows: AudienceRow[] = [];
  for (const p of people) {
    const inBranch = p.codes === null || p.codes.some((c) => canonicalBranchCode(c) === channel.branchCode);
    let why: AudienceWhy | null;
    if (p.isSuper) why = 'super';
    else if (!inBranch) why = null;
    else if (channel.branchWide) why = 'branch';
    else if (erpOnly && !p.hasErp) why = 'no-erp';
    else why = p.stored.includes(channel.grant) ? 'on' : 'off';
    if (why) rows.push({ id: p.id, name: p.name, email: p.email, role: p.role, why, canToggle: why === 'on' || why === 'off' });
  }
  return rows.sort((a, z) => ORDER[a.why] - ORDER[z.why] || a.name.localeCompare(z.name));
}

function channelById(channelId: string): AlertChannelDef {
  const channel = ALERT_CHANNELS.find((c) => c.id === channelId);
  if (!channel) throw NotFound(`Unknown alert channel "${channelId}"`);
  return channel;
}

export const alertAudience = {
  async forChannel(viewer: MongoAccess, channelId: string) {
    const channel = channelById(channelId);
    // listUsers already hides app-disabled users; keep only those the app lets sign in
    // (auth.ts: an active CRM user with access.app === true).
    const listed = await directoryService.listUsers(viewer);
    const crmUsers = await crmRepo.listUsers({ _id: { $in: listed.map((u) => new Types.ObjectId(u.id)) } });
    const canSignIn = crmUsers.filter((u) => u.status === 'active' && u.access?.app === true);
    const signIn = new Set(canSignIn.map((u) => String(u._id)));
    const people = listed.filter((u) => signIn.has(u.id));
    const ids = people.map((u) => u.id);
    const roles = await crmRepo.listRoles();
    const superRoles = new Set(roles.filter((r) => r.level === 1 || (r.permissions ?? []).includes('*')).map((r) => String(r._id)));
    const [codes, stored, erp] = await Promise.all([branchCodesByUser(people), alertGrants.storedFor(ids), erpAccessIds(canSignIn)]);
    const rows = buildChannelAudience(channel, people.map((u) => ({
      id: u.id,
      name: u.name,
      email: u.email,
      role: u.role,
      isSuper: !!u.roleId && superRoles.has(u.roleId),
      codes: codes[u.id],
      hasErp: erp.has(u.id),
      stored: stored[u.id] ?? [],
    })));
    return {
      channel: { id: channel.id, name: channel.name, branchCode: channel.branchCode, branchWide: !!channel.branchWide, needsErp: needsErpAccess(channel.grant) },
      rows,
    };
  },

  // Flip ONE user's switch for ONE channel. Returns the user's saved grants; refuses (after saving
  // nothing new) when the switch cannot take effect for them.
  async setForChannel(userId: string, channelId: string, on: boolean, by: string): Promise<string[]> {
    const channel = channelById(channelId);
    if (channel.branchWide) throw BadRequest(`Everyone in ${channel.branchCode} sees ${channel.name} — there is no switch for it`);
    const current = await alertGrants.grantsFor(userId);
    const next = on ? [...current, channel.grant] : current.filter((g) => g !== channel.grant);
    const saved = await alertGrants.setGrants(userId, next, by);
    if (on && !saved.includes(channel.grant)) {
      const need = needsErpAccess(channel.grant) ? `access to ${channel.branchCode} and ERP access` : `access to ${channel.branchCode}`;
      throw BadRequest(`This user can't get ${channel.name} alerts — they need ${need}`);
    }
    return saved;
  },
};
