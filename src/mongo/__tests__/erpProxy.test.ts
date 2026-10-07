import express from 'express';
import request from 'supertest';

// ERP approvals forwarding (owner, 2026-10-07). No DB, no network: requireAuth is stubbed to a
// signed-in user and global fetch is replaced. Pins: allow-list, the exact four headers (acting
// user from the verified session only), ERP 401 never reaches the phone as 401, status/body
// pass-through, query preserved, 503 when not configured.
const mockErp: { apiUrl?: string; appServiceToken?: string } = { apiUrl: 'https://erp.test', appServiceToken: 'shh-secret' };
jest.mock('../../config', () => ({ config: { get erp() { return mockErp; } } }));
jest.mock('../middleware', () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.auth = { userId: '64b000000000000000000001', role: 'employee' };
    next();
  },
}));

import { erpRouter } from '../erp/erp.router';
import { isAllowedErpCall } from '../erp/erpAllowList';
import { errorHandler } from '../../common/errors';

const ID = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const app = express();
app.use(express.json());
app.use('/api/erp', erpRouter);
app.use(errorHandler);

type Call = { url: string; init: RequestInit };
let calls: Call[] = [];
let reply: { status: number; body: unknown } = { status: 200, body: { success: true, data: [] } };
const realFetch = global.fetch;
beforeEach(() => {
  calls = [];
  reply = { status: 200, body: { success: true, data: [] } };
  mockErp.apiUrl = 'https://erp.test';
  mockErp.appServiceToken = 'shh-secret';
  global.fetch = jest.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const text = typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body);
    return new Response(text, { status: reply.status, headers: { 'Content-Type': 'application/json' } });
  }) as unknown as typeof fetch;
});
afterAll(() => { global.fetch = realFetch; });

describe('allow-list', () => {
  it.each([
    ['GET', '/api/auth/whoami'], ['GET', '/api/app-config/approval.approveEmails'], ['GET', '/api/pending-work/approvals'],
    ['GET', '/api/vouchers/approvals'], ['GET', '/api/vouchers/approval-counts'], ['GET', `/api/vouchers/${ID}`],
    ['GET', `/api/vouchers/${ID}/journal`], ['POST', `/api/vouchers/${ID}/review`], ['POST', `/api/vouchers/${ID}/approve`],
    ['POST', `/api/vouchers/${ID}/reject`], ['GET', '/api/booking-orders'], ['GET', `/api/booking-orders/${ID}`],
    ['POST', `/api/booking-orders/${ID}/review`], ['GET', '/api/tk/change-requests'], ['POST', `/api/tk/change-requests/${ID}/act`],
    ['GET', '/api/tk/inbox'], ['GET', '/api/credit-facilities/requests'], ['GET', '/api/hr/employees/leave-applications'],
    ['PUT', `/api/hr/employees/leave-applications/${ID}/reject`], ['GET', '/api/reconciliation/close/board'],
  ])('%s %s is allowed', (m, p) => expect(isAllowedErpCall(m, p)).toBe(true));

  it.each([
    ['DELETE', `/api/vouchers/${ID}`], ['POST', '/api/vouchers/approve-all'], ['POST', '/api/vouchers/approve-many'],
    ['GET', '/api/vouchers/abc'], ['GET', '/api/ledgers'], ['POST', '/api/auth/login'], ['POST', `/api/vouchers/${ID}/revoke`],
    ['GET', '/api/app-config/jwt.secret'],
  ])('%s %s is refused', (m, p) => expect(isAllowedErpCall(m, p)).toBe(false));

  it('a refused call never reaches the ERP', async () => {
    const r = await request(app).delete(`/api/erp/vouchers/${ID}`);
    expect(r.status).toBe(404);
    expect(calls).toHaveLength(0);
  });
});

describe('forwarding', () => {
  it('sends exactly the four headers, with the signed-in user — never the client’s', async () => {
    await request(app)
      .get('/api/erp/vouchers/approvals?status=pending&branch=BOM')
      .set('Authorization', 'Bearer phone-jwt')
      .set('X-Act-As', '64b0000000000000000000ff')
      .set('X-App-Service-Token', 'forged');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://erp.test/api/vouchers/approvals?status=pending&branch=BOM');
    expect(calls[0].init.headers).toEqual({
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'X-App-Service-Token': 'shh-secret',
      'X-Act-As': '64b000000000000000000001',
    });
    expect(calls[0].init.body).toBeUndefined();
  });

  it('forwards a POST body', async () => {
    await request(app).post(`/api/erp/vouchers/${ID}/review?branch=BOM`).send({ action: 'check' });
    expect(calls[0].init.method).toBe('POST');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ action: 'check' });
  });

  it('passes a 200 straight through', async () => {
    reply = { status: 200, body: { success: true, data: { entries: [{ id: 'x' }] } } };
    const r = await request(app).get('/api/erp/vouchers/approvals');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ success: true, data: { entries: [{ id: 'x' }] } });
  });

  it('keeps the ERP’s refusal and reason (422)', async () => {
    reply = { status: 422, body: { success: false, message: 'Awaiting Check', code: 'VCHR-GATE-07' } };
    const r = await request(app).post(`/api/erp/vouchers/${ID}/approve`).send({});
    expect(r.status).toBe(422);
    expect(r.body.error).toMatchObject({ code: 'VCHR-GATE-07', message: 'Awaiting Check' });
  });

  it('an ERP 401 reaches the phone as 502 ERP_AUTH, never 401', async () => {
    reply = { status: 401, body: { success: false, message: 'Invalid app service token' } };
    const r = await request(app).get('/api/erp/auth/whoami');
    expect(r.status).toBe(502);
    expect(r.body.error.code).toBe('ERP_AUTH');
  });

  it('an unreadable ERP answer is 502', async () => {
    reply = { status: 502, body: '<html>Bad Gateway</html>' };
    const r = await request(app).get('/api/erp/auth/whoami');
    expect(r.status).toBe(502);
    expect(r.body.error.code).toBe('ERP_BAD_GATEWAY');
  });
});

describe('set-up', () => {
  it('status says whether the link is configured', async () => {
    expect((await request(app).get('/api/erp/status')).body).toEqual({ configured: true });
    mockErp.appServiceToken = undefined;
    expect((await request(app).get('/api/erp/status')).body).toEqual({ configured: false });
  });

  it('503 when not configured, and nothing is called', async () => {
    mockErp.apiUrl = undefined;
    const r = await request(app).get('/api/erp/vouchers/approvals');
    expect(r.status).toBe(503);
    expect(r.body.error.code).toBe('ERP_NOT_CONFIGURED');
    expect(calls).toHaveLength(0);
  });
});
