// No DB. The mute rules themselves, and that a muted user is left out of the push fan-out while
// everyone else in the channel's audience still gets it.
const mutedDocs: { userId: string; channelId: string; until: Date | null }[] = [];
const askedTokensFor: string[] = [];

jest.mock('../../connection', () => ({
  appDb: () => ({
    collection: (name: string) => ({
      find: (filter: { channelId?: string; userId?: { $in: string[] } }) => ({
        toArray: async () => (name === 'alert_mutes'
          ? mutedDocs.filter((d) => d.channelId === filter.channelId && (filter.userId?.$in ?? []).includes(d.userId))
          : []), // app_access: nobody disabled
      }),
    }),
  }),
}));
jest.mock('../../crm.repo', () => ({
  crmRepo: {
    listRoles: async () => [{ _id: 'r-super', level: 1 }, { _id: 'r-staff', level: 4 }],
    listUsers: async () => [
      { _id: 'super', role_id: 'r-super', branch_ids: [] },
      { _id: 'bom-a', role_id: 'r-staff', branch_ids: ['b-bom'] },
      { _id: 'bom-b', role_id: 'r-staff', branch_ids: ['b-bom'] },
    ],
    listBranches: async () => [{ _id: 'b-bom', code: 'BOM' }],
  },
}));
jest.mock('../../calls/call.repository', () => ({
  callDeviceRepo: { tokensForUser: async (id: string) => { askedTokensFor.push(id); return []; } },
}));

import { activeMuteMap, isMutableChannel, isMuteRunning, muteUntil } from '../alertMutes';
import { alertPush } from '../alert.push';

describe('alert mute rules', () => {
  const now = Date.UTC(2026, 8, 30, 10, 0, 0);

  it('8 hours / 1 week end that far from now; no hours = always (null)', () => {
    expect(muteUntil(8, now)?.getTime()).toBe(now + 8 * 3600_000);
    expect(muteUntil(24 * 7, now)?.getTime()).toBe(now + 7 * 24 * 3600_000);
    expect(muteUntil(null, now)).toBeNull();
    expect(muteUntil(undefined, now)).toBeNull();
  });

  it('an "always" mute runs forever; a timed one only until it ends', () => {
    expect(isMuteRunning(null, now)).toBe(true);
    expect(isMuteRunning(new Date(now + 1000), now)).toBe(true);
    expect(isMuteRunning(new Date(now - 1000), now)).toBe(false);
  });

  it('the app gets only the mutes still running, as epoch ms or null', () => {
    expect(activeMuteMap([
      { channelId: 'tk_erp_bom', until: null },
      { channelId: 'tk_erp_amd', until: new Date(now + 60_000) },
      { channelId: 'tk_hr_bom', until: new Date(now - 60_000) }, // ran out — TTL not swept yet
    ], now)).toEqual({ tk_erp_bom: null, tk_erp_amd: now + 60_000 });
  });

  it('every alert channel, My Alerts and Announcements can be muted; nothing else', () => {
    for (const id of ['tk_erp_bom', 'tk_lead_nbo', 'tk_erprep_mhub', 'tk_hr_dar', 'user_alerts', 'announcements']) expect(isMutableChannel(id)).toBe(true);
    for (const id of ['tk_ghost', 'grp_erp', '']) expect(isMutableChannel(id)).toBe(false);
  });
});

describe('alert push skips users who muted the channel', () => {
  beforeEach(() => { mutedDocs.length = 0; askedTokensFor.length = 0; });

  it('a branch-wide CRM alert reaches the branch minus whoever muted it', async () => {
    mutedDocs.push({ userId: 'bom-a', channelId: 'tk_lead_bom', until: null });
    await alertPush.sendChannelAlert('tk_lead_bom', 'Lead converted', 'QRY-1');
    expect(askedTokensFor.sort()).toEqual(['bom-b', 'super']);
  });

  it('a mute on another channel, or one that has run out, changes nothing', async () => {
    mutedDocs.push({ userId: 'bom-a', channelId: 'tk_lead_amd', until: null });
    mutedDocs.push({ userId: 'bom-b', channelId: 'tk_lead_bom', until: new Date(Date.now() - 1000) });
    await alertPush.sendChannelAlert('tk_lead_bom', 'Lead converted', 'QRY-2');
    expect(askedTokensFor.sort()).toEqual(['bom-a', 'bom-b', 'super']);
  });

  it('muting My Alerts stops the personal check-in push', async () => {
    mutedDocs.push({ userId: 'bom-a', channelId: 'user_alerts', until: new Date(Date.now() + 3600_000) });
    await alertPush.sendUserAlert('bom-a', 'You checked in', '09:15');
    expect(askedTokensFor).toEqual([]);
  });
});
