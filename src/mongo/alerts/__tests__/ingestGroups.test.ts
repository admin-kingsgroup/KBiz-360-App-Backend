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
