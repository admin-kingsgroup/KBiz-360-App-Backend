import express from 'express';
import request from 'supertest';
import { config } from '../../../config';
import { errorHandler } from '../../../common/errors';

// The department a task is given with (owner, 2026-11-19) must get through BOTH doors — the app's
// /api/tasks and the ERP's /api/service/tasks — and nothing but Operations / Accounts may.
jest.mock('../task.service', () => ({ tasksService: { create: jest.fn(), patch: jest.fn() } }));
jest.mock('../../middleware', () => ({
  requireAuth: (req: { auth?: unknown }, _res: unknown, next: () => void) => { req.auth = { userId: 'u1' }; next(); },
}));
jest.mock('../../crm.repo', () => ({ crmRepo: { getUserById: async (id: string) => ({ _id: id, status: 'active' }) } }));
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { tasksService } = require('../task.service') as { tasksService: { create: jest.Mock; patch: jest.Mock } };
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { tasksRouter } = require('../tasks.router') as typeof import('../tasks.router');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { tasksServiceRouter } = require('../tasksService.router') as typeof import('../tasksService.router');

const TOKEN = 'test-ingest-token';
const app = express();
app.use(express.json());
app.use('/api/service/tasks', tasksServiceRouter);
app.use('/api/tasks', tasksRouter);
app.use(errorHandler);

beforeAll(() => { (config.alerts as { ingestToken: string }).ingestToken = TOKEN; });
beforeEach(() => {
  tasksService.create.mockReset().mockResolvedValue({ id: 't1' });
  tasksService.patch.mockReset().mockResolvedValue({ id: 't1' });
});

const task = { title: 'Close October books', assignedTo: 'u2', branchId: '64b000000000000000000002', priority: 'normal', dueDate: '2099-11-20' };

describe('department on the app door (/api/tasks)', () => {
  it('passes Operations / Accounts through on create', async () => {
    const res = await request(app).post('/api/tasks').send({ ...task, department: 'accounts' });
    expect(res.status).toBe(201);
    expect(tasksService.create.mock.calls[0][1]).toMatchObject({ department: 'accounts' });
  });
  it('is optional — an older app sends none', async () => {
    expect((await request(app).post('/api/tasks').send(task)).status).toBe(201);
  });
  it('refuses anything else', async () => {
    expect((await request(app).post('/api/tasks').send({ ...task, department: 'marketing' })).status).toBe(400);
    expect(tasksService.create).not.toHaveBeenCalled();
  });
  it('can be changed on edit', async () => {
    const res = await request(app).patch('/api/tasks/t1').send({ department: 'operations' });
    expect(res.status).toBe(200);
    expect(tasksService.patch.mock.calls[0][2]).toMatchObject({ department: 'operations' });
  });
});

describe('department on the ERP door (/api/service/tasks)', () => {
  const erp = (body: object) => request(app).post('/api/service/tasks').set('Authorization', `Bearer ${TOKEN}`).set('X-Act-As', 'u1').send(body);
  it('passes it through to the task', async () => {
    const res = await erp({ ...task, department: 'operations' });
    expect(res.status).toBe(201);
    expect(tasksService.create.mock.calls[0][1]).toMatchObject({ department: 'operations', source: 'erp' });
  });
  it('refuses anything else', async () => {
    expect((await erp({ ...task, department: 'sales' })).status).toBe(400);
  });
});
