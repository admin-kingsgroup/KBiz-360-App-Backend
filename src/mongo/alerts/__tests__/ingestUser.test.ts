import express from 'express';
import request from 'supertest';
import { config } from '../../../config';
import { errorHandler } from '../../../common/errors';

// POST /api/alerts/user, DB-less: the CRM's "assigned to you" lands in ONE person's My Alerts.
// alertService and the CRM user lookup are mocked, so these pin the HTTP contract the CRM codes
// against — who gets it, who is skipped, and that the client's number rides as `contact` only.
jest.mock('../alert.service', () => ({
  alertService: { hasEvent: jest.fn(), record: jest.fn(), recordUserAlert: jest.fn() },
}));
jest.mock('../../crm.repo', () => ({ crmRepo: { getUserById: jest.fn() } }));
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { alertService } = require('../alert.service') as { alertService: { recordUserAlert: jest.Mock } };
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { crmRepo } = require('../../crm.repo') as { crmRepo: { getUserById: jest.Mock } };
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { alertsIngestRouter } = require('../alertsIngest.router') as typeof import('../alertsIngest.router');

const TOKEN = 'test-ingest-token';
const USER = '64b7f0c2a1b2c3d4e5f60718';
const app = express();
app.use(express.json());
app.use('/api/alerts', alertsIngestRouter);
app.use(errorHandler);

beforeAll(() => { (config.alerts as { ingestToken: string }).ingestToken = TOKEN; });
beforeEach(() => {
  alertService.recordUserAlert.mockReset().mockResolvedValue(undefined);
  crmRepo.getUserById.mockReset().mockResolvedValue({ _id: USER, email: 'a@b.c', status: 'active' });
});

const post = (body: object, token: string | null = TOKEN) => {
  const r = request(app).post('/api/alerts/user');
  if (token) r.set('Authorization', `Bearer ${token}`);
  return r.send({ userId: USER, source: 'CRM', title: 'Query assigned to you — QRY-2026-000123', ...body });
};

describe('POST /api/alerts/user — a personal My Alerts event', () => {
  it('records into the user’s own channel with the CRM’s context', async () => {
    const res = await post({ body: 'Eric Rodgers · Holiday Package · Assigned by Harshit Jha', context: 'CRM · Queries' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, channelId: 'user_alerts' });
    expect(alertService.recordUserAlert).toHaveBeenCalledWith(USER, {
      source: 'CRM',
      title: 'Query assigned to you — QRY-2026-000123',
      body: 'Eric Rodgers · Holiday Package · Assigned by Harshit Jha',
      context: 'CRM · Queries',
    });
  });

  it('carries the client as a contact, normalised to E.164', async () => {
    const res = await post({ contact: { name: 'Eric Rodgers', phone: '+91 98765-43210' } });
    expect(res.status).toBe(200);
    expect(alertService.recordUserAlert).toHaveBeenCalledWith(USER, expect.objectContaining({
      body: '', context: 'CRM', contact: { name: 'Eric Rodgers', phone: '+919876543210' },
    }));
  });

  it('a number that is not international is refused, not guessed', async () => {
    expect((await post({ contact: { phone: '9876543210' } })).status).toBe(400);
    expect(alertService.recordUserAlert).not.toHaveBeenCalled();
  });

  it('an inactive user or one barred from the app is skipped quietly', async () => {
    crmRepo.getUserById.mockResolvedValueOnce({ _id: USER, status: 'inactive' });
    expect((await post({})).body).toEqual({ ok: true, skipped: 'inactive' });
    crmRepo.getUserById.mockResolvedValueOnce({ _id: USER, status: 'active', access: { app: false } });
    expect((await post({})).body).toEqual({ ok: true, skipped: 'no-app-access' });
    expect(alertService.recordUserAlert).not.toHaveBeenCalled();
  });

  it('an unknown user or a malformed id 400s', async () => {
    crmRepo.getUserById.mockResolvedValueOnce(null);
    expect((await post({})).status).toBe(400);
    expect((await post({ userId: 'nope' })).status).toBe(400);
    expect(alertService.recordUserAlert).not.toHaveBeenCalled();
  });

  it('needs the service token', async () => {
    expect((await post({}, null)).status).toBe(401);
    expect((await post({}, 'wrong')).status).toBe(401);
    expect(alertService.recordUserAlert).not.toHaveBeenCalled();
  });
});
