// No DB. A user switched off in the app's Team & Users (app_access enabled:false) gets no alert push.
// Before 2026-10-07 the push looked for \`disabled: true\`, which no row has, so they kept receiving
// every channel's pushes.
const askedTokensFor: string[] = [];

jest.mock('../../connection', () => ({
  appDb: () => ({ collection: () => ({ find: () => ({ toArray: async () => [] }) }) }),
}));
jest.mock('../../appAccess', () => ({ appAccess: { disabledSet: async () => new Set<string>(['bom-b']) } }));
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

import { alertPush } from '../alert.push';

describe('alert push skips users switched off in the app', () => {
  it('a branch-wide alert reaches the branch except the switched-off user', async () => {
    await alertPush.sendChannelAlert('tk_lead_bom', 'Lead converted', 'QRY-9');
    expect(askedTokensFor.sort()).toEqual(['bom-a', 'super']);
  });
});
