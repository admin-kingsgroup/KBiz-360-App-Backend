import express from 'express';
import request from 'supertest';
import { config } from '../../../config';
import { errorHandler } from '../../../common/errors';

// The ingest route, DB-less: alertService is mocked so these pin the HTTP contract the ERP and
// CRM code against — the new modules, the per-channel dedupeKey, and the early duplicate answer
// that skips the PDF upload.
jest.mock('../alert.service', () => ({
  alertService: {
    hasEvent: jest.fn(),
    record: jest.fn(),
  },
}));
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { alertService } = require('../alert.service') as { alertService: { hasEvent: jest.Mock; record: jest.Mock } };
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { alertsIngestRouter } = require('../alertsIngest.router') as typeof import('../alertsIngest.router');

const TOKEN = 'test-ingest-token';
const app = express();
app.use(express.json({ limit: '5mb' }));
app.use('/api/alerts', alertsIngestRouter);
app.use(errorHandler);

beforeAll(() => { (config.alerts as { ingestToken: string }).ingestToken = TOKEN; });
beforeEach(() => {
  alertService.hasEvent.mockReset().mockResolvedValue(false);
  alertService.record.mockReset().mockResolvedValue({ duplicate: false });
});

const post = (body: object) =>
  request(app).post('/api/alerts/ingest').set('Authorization', `Bearer ${TOKEN}`).send({ source: 'KBiz Books', title: 't', ...body });

describe('POST /api/alerts/ingest — Alerts groups', () => {
  it.each([
    ['erp', 'BOM', 'tk_erp_bom', 'TK BOM · ERP'],
    ['erp-reports', 'MHUB', 'tk_erprep_mhub', 'TK MHUB · ERP Reports'],
    ['crm-reports', 'NBO', 'tk_crmrep_nbo', 'TK NBO · CRM Reports'],
    ['leads', 'AMD', 'tk_lead_amd', 'TK AMD · CRM'],
  ])('module %s / %s → %s', async (module, branchCode, channelId, context) => {
    const res = await post({ module, branchCode, dedupeKey: 'k-1' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, channelId });
    expect(alertService.record).toHaveBeenCalledWith(channelId, expect.objectContaining({ context }), null, 'k-1');
  });

  it('a repeated dedupeKey answers duplicate BEFORE anything is stored', async () => {
    alertService.hasEvent.mockResolvedValue(true);
    const res = await post({ module: 'erp-reports', branchCode: 'BOM', dedupeKey: 'ar-BOM-2026-09-27' });
    expect(res.body).toEqual({ ok: true, channelId: 'tk_erprep_bom', duplicate: true });
    expect(alertService.hasEvent).toHaveBeenCalledWith('tk_erprep_bom', 'ar-BOM-2026-09-27');
    expect(alertService.record).not.toHaveBeenCalled();
  });

  it('a race lost inside record() still reports duplicate', async () => {
    alertService.record.mockResolvedValue({ duplicate: true });
    const res = await post({ module: 'erp', branchCode: 'BOM', dedupeKey: 'x' });
    expect(res.body).toEqual({ ok: true, channelId: 'tk_erp_bom', duplicate: true });
  });

  it('HR is not ingestable (the app writes attendance itself); unknown branches 400', async () => {
    expect((await post({ module: 'attendance', branchCode: 'BOM' })).status).toBe(400);
    expect((await post({ module: 'crm-reports', branchCode: 'MHUB' })).status).toBe(400);
    expect(alertService.record).not.toHaveBeenCalled();
  });

  it('no dedupeKey → no lookup, recorded as before', async () => {
    const res = await post({ module: 'erp', branchCode: 'DAR' });
    expect(res.status).toBe(200);
    expect(alertService.hasEvent).not.toHaveBeenCalled();
    expect(alertService.record).toHaveBeenCalledWith('tk_erp_dar', expect.any(Object), null, undefined);
  });
});

describe('POST /api/alerts/ingest — KGD Alerts (owner, 2026-10-07)', () => {
  it.each([
    ['crm', 'tk_kgd_crm', 'KGD · CRM tickets'],
    ['erp', 'tk_kgd_erp', 'KGD · ERP tickets'],
  ])('system %s with no branchCode → %s', async (system, channelId, context) => {
    const res = await post({ module: 'kgd-tickets', system, source: 'CRM', title: 'Ticket TKT-0042 raised', dedupeKey: 'tkt-42' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, channelId });
    expect(alertService.hasEvent).toHaveBeenCalledWith(channelId, 'tkt-42');
    expect(alertService.record).toHaveBeenCalledWith(channelId, expect.objectContaining({ context, title: 'Ticket TKT-0042 raised' }), null, 'tkt-42');
  });

  it('a branchCode sent with a KGD ticket is ignored — the CRM’s KGD branch, another branch, or null', async () => {
    for (const branchCode of ['KGD', 'BOM', null]) {
      const res = await post({ module: 'kgd-tickets', system: 'erp', branchCode });
      expect(res.status).toBe(200);
      expect(res.body.channelId).toBe('tk_kgd_erp');
    }
  });

  it('a caller-sent context wins over the default', async () => {
    await post({ module: 'kgd-tickets', system: 'crm', context: 'KGD · CRM tickets · High' });
    expect(alertService.record).toHaveBeenCalledWith('tk_kgd_crm', expect.objectContaining({ context: 'KGD · CRM tickets · High' }), null, undefined);
  });

  it('kgd-tickets without `system` (or with an unknown one) is a 400', async () => {
    expect((await post({ module: 'kgd-tickets' })).status).toBe(400);
    expect((await post({ module: 'kgd-tickets', branchCode: 'KGD' })).status).toBe(400);
    expect((await post({ module: 'kgd-tickets', system: 'books' })).status).toBe(400);
    expect(alertService.record).not.toHaveBeenCalled();
  });

  it('every other module still needs its branchCode', async () => {
    expect((await post({ module: 'erp' })).status).toBe(400);
    expect((await post({ module: 'leads', system: 'crm' })).status).toBe(400);
    expect((await post({ module: 'erp', branchCode: 'B' })).status).toBe(400);
    expect((await post({ module: 'erp', branchCode: null })).status).toBe(400);
    expect(alertService.record).not.toHaveBeenCalled();
  });
});

describe('POST /api/alerts/ingest — `link` (the card’s Open button, 2026-10-07)', () => {
  const LINK = 'https://crm.kingsgroup.example/tickets/TKT-0042';

  it('is stored with the event, for KGD and for every other module', async () => {
    expect((await post({ module: 'kgd-tickets', system: 'crm', link: LINK })).status).toBe(200);
    expect(alertService.record).toHaveBeenLastCalledWith('tk_kgd_crm', expect.objectContaining({ link: LINK }), null, undefined);
    expect((await post({ module: 'erp', branchCode: 'BOM', link: ` ${LINK} ` })).status).toBe(200);
    expect(alertService.record).toHaveBeenLastCalledWith('tk_erp_bom', expect.objectContaining({ link: LINK }), null, undefined);
  });

  it('is left off the event when not sent', async () => {
    await post({ module: 'erp', branchCode: 'BOM' });
    expect(alertService.record.mock.calls[0][1]).not.toHaveProperty('link');
  });

  it.each([
    ['plain http', 'http://crm.kingsgroup.example/tickets/1'],
    ['javascript:', 'javascript:alert(1)'],
    ['data:', 'data:text/html,<script>alert(1)</script>'],
    ['not a URL', 'tickets/TKT-0042'],
    ['over 500 chars', `https://x.example/${'a'.repeat(490)}`],
  ])('%s → 400', async (_label, link) => {
    const res = await post({ module: 'kgd-tickets', system: 'erp', link });
    expect(res.status).toBe(400);
    expect(alertService.record).not.toHaveBeenCalled();
  });
});
