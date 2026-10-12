import express from 'express';
import request from 'supertest';

// The payslip in the app (owner, 2026-10-12): the ERP's own payslip, released (paid-in-full) months
// only. No DB, no network: requireAuth is stubbed to a signed-in user and global fetch is replaced.
// Pins: the exact ERP paths + three headers (acting user from the verified session only), month
// validation before any call, ERP 403 reason passed through, ERP 401 never a 401 to the phone,
// 503 when the ERP link is not set up, and the retired indicative payslip answering 410.
const mockErp: { apiUrl?: string; appServiceToken?: string } = { apiUrl: 'https://erp.test', appServiceToken: 'shh-secret' };
jest.mock('../../../config', () => ({ config: { get erp() { return mockErp; } } }));
jest.mock('../../middleware', () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.auth = { userId: '64b000000000000000000001', role: 'employee' };
    next();
  },
  requireSuper: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
}));

import { hrRouter, payslipMonthParamsSchema } from '../hr.router';
import { payslipErp, toPayslipMonth } from '../payslip.erp';
import { errorHandler } from '../../../common/errors';

const USER = '64b000000000000000000001';
const app = express();
app.use(express.json());
app.use('/api/hr', hrRouter);
app.use(errorHandler);

const SEPT = { month: '2026-09', label: 'September 2026', branch: 'MHUB', net: 41250, currency: 'INR', vno: 'SAL/MHUB/26/0009', paidOn: '2026-10-07', source: 'paid' };
const AUG = { month: '2026-08', label: 'August 2026', branch: 'MHUB', net: 40100, currency: 'INR', vno: '', paidOn: '', source: 'history' };

type Call = { url: string; init: RequestInit };
let calls: Call[] = [];
let reply: { status: number; body: unknown } = { status: 200, body: { success: true, data: { months: [] } } };
let throwOnFetch: Error | null = null;
const realFetch = global.fetch;
beforeEach(() => {
  calls = [];
  throwOnFetch = null;
  reply = { status: 200, body: { success: true, data: { months: [] } } };
  mockErp.apiUrl = 'https://erp.test';
  mockErp.appServiceToken = 'shh-secret';
  global.fetch = jest.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    if (throwOnFetch) throw throwOnFetch;
    const text = typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body);
    return new Response(text, { status: reply.status, headers: { 'Content-Type': 'application/json' } });
  }) as unknown as typeof fetch;
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());
afterAll(() => { global.fetch = realFetch; });

describe('GET /api/hr/payslips', () => {
  it('asks the ERP app-hr door with exactly the three headers, as the signed-in user — never the client’s', async () => {
    reply = { status: 200, body: { success: true, data: { months: [SEPT, AUG] } } };
    const r = await request(app)
      .get('/api/hr/payslips')
      .set('Authorization', 'Bearer phone-jwt')
      .set('X-Act-As', '64b0000000000000000000ff')
      .set('X-App-Service-Token', 'forged');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ months: [SEPT, AUG] });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://erp.test/api/app-hr/payslips');
    expect(calls[0].init.method).toBe('GET');
    expect(calls[0].init.headers).toEqual({
      Accept: 'application/json',
      'X-App-Service-Token': 'shh-secret',
      'X-Act-As': USER,
    });
    expect(calls[0].init.signal).toBeDefined();
  });

  it('only the contract’s fields reach the phone; rows without a month are dropped', async () => {
    reply = { status: 200, body: { success: true, data: { months: [{ ...SEPT, employeeId: 'E1', salary: 99 }, { label: 'junk' }] } } };
    const r = await request(app).get('/api/hr/payslips');
    expect(r.body.months).toEqual([SEPT]);
  });

  it('no months → an empty list (never an error)', async () => {
    reply = { status: 200, body: { success: true, data: {} } };
    expect((await request(app).get('/api/hr/payslips')).body).toEqual({ months: [] });
  });

  it('503 when the ERP link is not set up, and nothing is called', async () => {
    mockErp.appServiceToken = undefined;
    const r = await request(app).get('/api/hr/payslips');
    expect(r.status).toBe(503);
    expect(r.body.error).toMatchObject({ code: 'ERP_NOT_CONFIGURED', message: 'Payslips are not available right now' });
    expect(calls).toHaveLength(0);
  });

  it('an ERP 401 reaches the phone as 502 ERP_AUTH, never 401 (the app reads 401 as sign-out)', async () => {
    reply = { status: 401, body: { success: false, message: 'This login is not active.' } };
    const r = await request(app).get('/api/hr/payslips');
    expect(r.status).toBe(502);
    expect(r.body.error).toMatchObject({ code: 'ERP_AUTH', message: 'This login is not active.' });
  });

  it('an ERP 5xx is 502 with its message; an unreadable answer is 502 ERP_BAD_GATEWAY', async () => {
    reply = { status: 500, body: { success: false, message: 'boom' } };
    let r = await request(app).get('/api/hr/payslips');
    expect(r.status).toBe(502);
    expect(r.body.error).toMatchObject({ code: 'ERP_ERROR', message: 'boom' });
    reply = { status: 502, body: '<html>Bad Gateway</html>' };
    r = await request(app).get('/api/hr/payslips');
    expect(r.status).toBe(502);
    expect(r.body.error.code).toBe('ERP_BAD_GATEWAY');
  });

  it('unreachable → 502, timeout → 504', async () => {
    throwOnFetch = new Error('ECONNREFUSED');
    expect((await request(app).get('/api/hr/payslips')).status).toBe(502);
    throwOnFetch = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const r = await request(app).get('/api/hr/payslips');
    expect(r.status).toBe(504);
    expect(r.body.error.code).toBe('ERP_TIMEOUT');
  });
});

describe('GET /api/hr/payslips/:month/link', () => {
  const LINK = { url: 'https://books.test/payslip-view?t=abc.def', expiresAt: '2026-10-12T10:15:00.000Z', month: '2026-09', label: 'September 2026' };

  it('forwards the month and returns the signed link', async () => {
    reply = { status: 200, body: { success: true, data: LINK } };
    const r = await request(app).get('/api/hr/payslips/2026-09/link');
    expect(r.status).toBe(200);
    expect(r.body).toEqual(LINK);
    expect(calls[0].url).toBe('https://erp.test/api/app-hr/payslips/2026-09/link');
    expect((calls[0].init.headers as Record<string, string>)['X-Act-As']).toBe(USER);
  });

  it.each(['2026-9', '2026-13', '2026-00', '26-09', 'latest', '2026-09-01'])('refuses month %s with 400 before calling the ERP', async (m) => {
    const r = await request(app).get(`/api/hr/payslips/${m}/link`);
    expect(r.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it('passes the ERP’s 403 (not released yet) through with its own message and code', async () => {
    reply = { status: 403, body: { success: false, code: 'PAYSLIP-NOT-RELEASED', message: 'Your October 2026 payslip shows here once that salary is paid.' } };
    const r = await request(app).get('/api/hr/payslips/2026-10/link');
    expect(r.status).toBe(403);
    expect(r.body.error).toEqual({ code: 'PAYSLIP-NOT-RELEASED', message: 'Your October 2026 payslip shows here once that salary is paid.' });
  });

  it('passes a 404 through; a 401 becomes 502', async () => {
    reply = { status: 404, body: { success: false, message: 'This payslip is not on the salary register any more — ask HR.' } };
    let r = await request(app).get('/api/hr/payslips/2026-09/link');
    expect(r.status).toBe(404);
    expect(r.body.error).toMatchObject({ code: 'ERP_REFUSED', message: 'This payslip is not on the salary register any more — ask HR.' });
    reply = { status: 401, body: { success: false, message: 'Invalid app service token' } };
    r = await request(app).get('/api/hr/payslips/2026-09/link');
    expect(r.status).toBe(502);
    expect(r.body.error.code).toBe('ERP_AUTH');
  });

  it('a 200 without a usable url is 502, not a blank WebView', async () => {
    reply = { status: 200, body: { success: true, data: { expiresAt: LINK.expiresAt } } };
    const r = await request(app).get('/api/hr/payslips/2026-09/link');
    expect(r.status).toBe(502);
  });

  it('503 when not configured', async () => {
    mockErp.apiUrl = undefined;
    expect((await request(app).get('/api/hr/payslips/2026-09/link')).status).toBe(503);
    expect(calls).toHaveLength(0);
  });
});

describe('the retired indicative payslip', () => {
  it('GET /api/hr/my-payslip answers 410 PAYSLIP_MOVED and never prices a month', async () => {
    const r = await request(app).get('/api/hr/my-payslip?month=2026-10');
    expect(r.status).toBe(410);
    expect(r.body.error).toMatchObject({ code: 'PAYSLIP_MOVED', message: 'Payslips now come from HR once your salary is paid — update the app.' });
    expect(calls).toHaveLength(0);
  });
});

describe('pure pieces', () => {
  it('the month params schema takes YYYY-MM only', () => {
    expect(payslipMonthParamsSchema.parse({ month: '2026-09' })).toEqual({ month: '2026-09' });
    expect(() => payslipMonthParamsSchema.parse({ month: '2026-9' })).toThrow();
  });

  it('the service validates the month itself too (defence in depth)', async () => {
    await expect(payslipErp.link(USER, '2026/09')).rejects.toMatchObject({ status: 400 });
    expect(calls).toHaveLength(0);
  });

  it('toPayslipMonth normalises odd values', () => {
    expect(toPayslipMonth({ month: '2026-07', net: '1200.5', source: 'weird' })).toEqual({
      month: '2026-07', label: '2026-07', branch: '', net: 1200.5, currency: '', vno: '', paidOn: '', source: 'paid',
    });
    expect(toPayslipMonth(null)).toBeNull();
  });
});
