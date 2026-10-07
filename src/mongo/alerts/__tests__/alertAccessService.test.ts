import express from 'express';
import request from 'supertest';
import { config } from '../../../config';
import { errorHandler } from '../../../common/errors';

// /api/service/alert-access, DB-less: the ERP's "who sees which alert" door (owner, 2026-10-07).
// The CRM users/roles/branches and the app_access gate are mocked; alert_grants is an in-memory
// collection under the REAL alertGrants, so these pin the HTTP contract the ERP codes against AND
// that a switch flipped from the ERP obeys the same rules as one flipped in Team & Users.
const T1 = 'aaaaaaaaaaaaaaaaaaaaaaa1';
const T2 = 'aaaaaaaaaaaaaaaaaaaaaaa2';
const B_BOM = 'bbbbbbbbbbbbbbbbbbbbbb01';
const B_HNBO = 'bbbbbbbbbbbbbbbbbbbbbb02';
const B_KGD = 'bbbbbbbbbbbbbbbbbbbbbb03';

interface U { _id: string; tenant_id: string; role_id: string; email: string; first_name: string; last_name?: string; status?: string; branch_ids: string[]; access?: { app?: boolean } }
const USERS: U[] = [
  { _id: 'erp-admin', tenant_id: T1, role_id: 'r1', email: 'admin@x', first_name: 'Erp', last_name: 'Admin', status: 'active', branch_ids: [] }, // no app access — still a valid actor
  { _id: 'u-bom', tenant_id: T1, role_id: 'r4', email: 'bom@x', first_name: 'Bina', status: 'active', branch_ids: [B_BOM], access: { app: true } },
  { _id: 'u-hnbo', tenant_id: T1, role_id: 'r4', email: 'nbo@x', first_name: 'Nadia', status: 'active', branch_ids: [B_HNBO], access: { app: true } },
  { _id: 'u-kgd', tenant_id: T1, role_id: 'r4', email: 'kgd@x', first_name: 'Kiran', status: 'active', branch_ids: [B_KGD], access: { app: true } },
  { _id: 'u-cm', tenant_id: T1, role_id: 'r2', email: 'cm@x', first_name: 'Chandra', status: 'active', branch_ids: [], access: { app: true } },
  { _id: 'u-super', tenant_id: T1, role_id: 'r1', email: 'sup@x', first_name: 'Afshin', status: 'active', branch_ids: [B_BOM], access: { app: true } },
  { _id: 'u-noapp', tenant_id: T1, role_id: 'r4', email: 'noapp@x', first_name: 'Noel', status: 'active', branch_ids: [B_BOM] },
  { _id: 'u-inactive', tenant_id: T1, role_id: 'r4', email: 'gone@x', first_name: 'Gita', status: 'inactive', branch_ids: [B_BOM], access: { app: true } },
  { _id: 'u-disabled', tenant_id: T1, role_id: 'r4', email: 'off@x', first_name: 'Dev', status: 'active', branch_ids: [B_BOM], access: { app: true } },
  { _id: 'u-t2', tenant_id: T2, role_id: 'r4', email: 't2@x', first_name: 'Other', status: 'active', branch_ids: [B_BOM], access: { app: true } },
];
const ROLES = [{ _id: 'r1', name: 'super_admin', level: 1 }, { _id: 'r2', name: 'company_manager', level: 2 }, { _id: 'r4', name: 'employee', level: 4 }];
const BRANCHES = [{ _id: B_BOM, code: 'BOM' }, { _id: B_HNBO, code: 'HNBO' }, { _id: B_KGD, code: 'KGD' }];

let grants: { userId: string; alerts: string[]; updatedBy?: string }[] = [];

jest.mock('../../connection', () => ({
  appDb: () => ({
    collection: () => ({
      findOne: async (f: { userId: string }) => grants.find((g) => g.userId === f.userId) ?? null,
      find: (f: { userId: { $in: string[] } }) => ({ toArray: async () => grants.filter((g) => f.userId.$in.includes(g.userId)) }),
      updateOne: async (f: { userId: string }, u: { $set: { alerts: string[]; updatedBy: string } }) => {
        grants = [...grants.filter((g) => g.userId !== f.userId), { userId: f.userId, alerts: u.$set.alerts, updatedBy: u.$set.updatedBy }];
      },
      deleteOne: async (f: { userId: string }) => { grants = grants.filter((g) => g.userId !== f.userId); },
    }),
  }),
}));
jest.mock('../../crm.repo', () => ({
  crmRepo: {
    getUserById: async (id: string) => USERS.find((u) => u._id === id) ?? null,
    listUsers: async (f: { tenant_id?: string }) => USERS.filter((u) => !f.tenant_id || String(u.tenant_id) === String(f.tenant_id)),
    listRoles: async () => ROLES,
    getRoleById: async (id: string) => ROLES.find((r) => r._id === String(id)) ?? null,
    listBranches: async () => BRANCHES,
    branchesByIds: async (ids: unknown[]) => BRANCHES.filter((b) => ids.map(String).includes(b._id)),
  },
}));
jest.mock('../../appAccess', () => ({ appAccess: { disabledSet: async () => new Set(['u-disabled']) } }));
jest.mock('../../chat/chat.events', () => ({ emitToUser: jest.fn(), emitToAll: jest.fn() }));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { emitToUser } = require('../../chat/chat.events') as { emitToUser: jest.Mock };
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { alertAccessServiceRouter } = require('../alertAccessService.router') as typeof import('../alertAccessService.router');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { ALERT_CHANNELS } = require('../alertChannels') as typeof import('../alertChannels');

const TOKEN = 'test-ingest-token';
const app = express();
app.use(express.json());
app.use('/api/service/alert-access', alertAccessServiceRouter);
app.use(errorHandler);

const setToken = (t: string | undefined) => { (config.alerts as { ingestToken?: string }).ingestToken = t; };
beforeEach(() => {
  setToken(TOKEN);
  grants = [];
  emitToUser.mockReset();
});

const get = (actAs: string | null = 'erp-admin') => {
  const r = request(app).get('/api/service/alert-access').set('X-Service-Token', TOKEN);
  return actAs ? r.set('X-Act-As', actAs) : r;
};
const grant = (body: object, actAs = 'erp-admin') =>
  request(app).post('/api/service/alert-access/grant').set('Authorization', `Bearer ${TOKEN}`).set('X-Act-As', actAs).send(body);

const KGD = ['KGD-crm-tickets', 'KGD-erp-tickets'];

describe('alert-access door — auth', () => {
  it('401 without the service token, or with a wrong one', async () => {
    expect((await request(app).get('/api/service/alert-access').set('X-Act-As', 'erp-admin')).status).toBe(401);
    expect((await request(app).get('/api/service/alert-access').set('X-Service-Token', 'nope').set('X-Act-As', 'erp-admin')).status).toBe(401);
    expect((await request(app).post('/api/service/alert-access/grant').send({ userId: 'u-bom', grant: 'BOM-erp', on: true })).status).toBe(401);
  });

  it('503 when the server has no ALERTS_INGEST_TOKEN', async () => {
    setToken(undefined);
    expect((await get()).status).toBe(503);
  });

  it('400 without X-Act-As; 403 for an unknown or inactive actor', async () => {
    expect((await get(null)).status).toBe(400);
    expect((await get('nobody')).status).toBe(403);
    expect((await get('u-inactive')).status).toBe(403);
    expect((await grant({ userId: 'u-bom', grant: 'BOM-erp', on: true }, 'nobody')).status).toBe(403);
    expect(grants).toEqual([]);
  });
});

describe('GET /api/service/alert-access', () => {
  it('lists every channel with its group and kind', async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.body.channels).toHaveLength(ALERT_CHANNELS.length);
    const byId = Object.fromEntries((res.body.channels as { id: string; group: string }[]).map((c) => [c.id, c]));
    expect(byId.tk_kgd_crm).toEqual({ id: 'tk_kgd_crm', name: 'KGD Alerts - CRM', branchCode: 'KGD', module: 'kgd-tickets', grant: 'KGD-crm-tickets', branchWide: false, companyWide: true, group: 'KGD Alerts' });
    expect(byId.tk_kgd_erp).toMatchObject({ grant: 'KGD-erp-tickets', companyWide: true, group: 'KGD Alerts' });
    expect(byId.tk_lead_bom).toEqual({ id: 'tk_lead_bom', name: 'CRM - BOM', branchCode: 'BOM', module: 'leads', grant: 'BOM-leads', branchWide: true, companyWide: false, group: 'CRM' });
    expect(byId.tk_erp_mhub).toMatchObject({ branchWide: false, companyWide: false, group: 'ERP' });
    expect(byId.tk_hr_nbo.group).toBe('HR');
    expect(byId.tk_crmrep_bom.group).toBe('CRM Reports');
    expect(byId.tk_erprep_dar.group).toBe('ERP Reports');
    expect(byId.tk_crm_amd.group).toBe('CRM Payments');
    expect(byId.tk_fin_bom.group).toBe('Finance');
  });

  it('lists the active app users of the actor’s tenant, by name, with their switches', async () => {
    grants = [
      { userId: 'u-hnbo', alerts: ['NBO-erp', 'BOM-erp', 'NBO-leads', 'KGD-crm-tickets'] }, // BOM-erp / NBO-leads open nothing
      { userId: 'u-noapp', alerts: ['BOM-erp'] },
    ];
    const res = await get();
    const users = res.body.users as { id: string; name: string; email: string; branchCodes: string[]; isSuper: boolean; grants: string[]; grantable: string[] }[];
    // No app access, inactive, switched off in Team & Users, or another tenant → not listed.
    expect(users.map((u) => u.id)).toEqual(['u-super', 'u-bom', 'u-cm', 'u-kgd', 'u-hnbo']);
    const u = Object.fromEntries(users.map((x) => [x.id, x]));
    expect(u['u-hnbo']).toEqual({
      id: 'u-hnbo', name: 'Nadia', email: 'nbo@x', branchCodes: ['NBO'], isSuper: false,
      grants: ['NBO-erp', 'KGD-crm-tickets'],
      grantable: ['NBO-attendance', 'NBO-erp', 'NBO-erp-reports', ...KGD],
    });
    expect(u['u-bom'].grantable).toEqual(['BOM-accounts', 'BOM-crm', 'BOM-attendance', 'BOM-erp', 'BOM-erp-reports', ...KGD]);
    expect(u['u-bom'].grants).toEqual([]);
    // The CRM's own KGD branch gives nothing but the company-wide pair everybody may hold.
    expect(u['u-kgd']).toMatchObject({ branchCodes: ['KGD'], grantable: KGD });
    // Company-wide roles may hold every grant-only switch; branch-wide channels are never a switch.
    const allGrantOnly = ALERT_CHANNELS.filter((c) => !c.branchWide).map((c) => c.grant);
    expect(u['u-cm'].grantable).toEqual(allGrantOnly);
    expect(u['u-cm'].grantable).not.toContain('BOM-leads');
    expect(u['u-super']).toMatchObject({ isSuper: true, branchCodes: ['BOM'], grantable: allGrantOnly });
  });
});

describe('POST /api/service/alert-access/grant', () => {
  it('switches one grant on and off, stamps the ERP actor, and tells the user’s live app', async () => {
    const on = await grant({ userId: 'u-hnbo', grant: 'KGD-erp-tickets', on: true });
    expect(on.status).toBe(200);
    expect(on.body).toEqual({ userId: 'u-hnbo', grants: ['KGD-erp-tickets'] });
    expect(grants).toEqual([{ userId: 'u-hnbo', alerts: ['KGD-erp-tickets'], updatedBy: 'erp:erp-admin' }]);
    expect(emitToUser).toHaveBeenCalledWith('u-hnbo', 'alert:visibility', { alerts: ['KGD-erp-tickets'] });

    const off = await grant({ userId: 'u-hnbo', grant: 'KGD-erp-tickets', on: false });
    expect(off.body).toEqual({ userId: 'u-hnbo', grants: [] });
    expect(grants).toEqual([]);
    expect(emitToUser).toHaveBeenLastCalledWith('u-hnbo', 'alert:visibility', { alerts: [] });
  });

  it('touches only that grant — the others stay as they were', async () => {
    grants = [{ userId: 'u-bom', alerts: ['BOM-erp', 'BOM-attendance'] }];
    expect((await grant({ userId: 'u-bom', grant: 'KGD-crm-tickets', on: true })).body.grants).toEqual(['BOM-erp', 'BOM-attendance', 'KGD-crm-tickets']);
    expect((await grant({ userId: 'u-bom', grant: 'BOM-erp', on: false })).body.grants).toEqual(['BOM-attendance', 'KGD-crm-tickets']);
    expect((await grant({ userId: 'u-bom', grant: 'BOM-attendance', on: true })).body.grants).toEqual(['BOM-attendance', 'KGD-crm-tickets']); // already on → no duplicate
  });

  it('a KGD grant works for a user with no KGD branch, and for a company-wide role', async () => {
    expect((await grant({ userId: 'u-bom', grant: 'KGD-erp-tickets', on: true })).status).toBe(200);
    expect((await grant({ userId: 'u-cm', grant: 'KGD-crm-tickets', on: true })).body.grants).toEqual(['KGD-crm-tickets']);
  });

  it('refuses a grant that is not in the user’s grantable list — and stores / emits nothing', async () => {
    for (const g of ['BOM-erp', 'NBO-leads', 'NBO-crm-reports', 'bogus']) {
      expect((await grant({ userId: 'u-hnbo', grant: g, on: true })).status).toBe(400);
    }
    expect((await grant({ userId: 'u-kgd', grant: 'BOM-erp', on: true })).status).toBe(400);
    // Not an active app user of the actor's tenant.
    for (const userId of ['u-noapp', 'u-inactive', 'u-disabled', 'u-t2', 'nobody']) {
      expect((await grant({ userId, grant: 'KGD-crm-tickets', on: true })).status).toBe(400);
    }
    expect((await grant({ userId: 'u-bom', grant: 'BOM-erp' })).status).toBe(400); // `on` is required
    expect(grants).toEqual([]);
    expect(emitToUser).not.toHaveBeenCalled();
  });
});
