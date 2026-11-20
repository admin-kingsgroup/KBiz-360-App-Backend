import express from 'express';
import request from 'supertest';
import { config } from '../../../config';
import { errorHandler } from '../../../common/errors';

// The ERP's Task tab (owner, 2026-11-20) reads lists, opens a task and moves its status through the
// service door — always AS the X-Act-As user, through the same tasksService the app uses.
jest.mock('../task.service', () => ({
  tasksService: { create: jest.fn(), list: jest.fn(), get: jest.fn(), changeStatus: jest.fn(), dashboard: jest.fn() },
}));
jest.mock('../../crm.repo', () => ({
  crmRepo: { getUserById: async (id: string) => (id === 'gone' ? null : { _id: id, status: id === 'off' ? 'inactive' : 'active' }) },
}));
type Mocked = Record<'create' | 'list' | 'get' | 'changeStatus' | 'dashboard', jest.Mock>;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { tasksService } = require('../task.service') as { tasksService: Mocked };
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { tasksServiceRouter } = require('../tasksService.router') as typeof import('../tasksService.router');

const TOKEN = 'test-ingest-token';
const app = express();
app.use(express.json());
app.use('/api/service/tasks', tasksServiceRouter);
app.use(errorHandler);

beforeAll(() => { (config.alerts as { ingestToken: string }).ingestToken = TOKEN; });
beforeEach(() => {
  tasksService.list.mockReset().mockResolvedValue([{ id: 't1' }]);
  tasksService.get.mockReset().mockResolvedValue({ task: { id: 't1' }, history: [] });
  tasksService.changeStatus.mockReset().mockResolvedValue({ id: 't1', status: 'accepted' });
  tasksService.dashboard.mockReset().mockResolvedValue({ counts: {}, byPerson: [], byBranch: [] });
});

const as = (user: string) => ({ Authorization: `Bearer ${TOKEN}`, 'X-Act-As': user });

describe('reading tasks through the ERP door', () => {
  it('lists one view as the acting user', async () => {
    const res = await request(app).get('/api/service/tasks?view=assigned&state=closed&q=books').set(as('u1'));
    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ id: 't1' }]);
    expect(tasksService.list.mock.calls[0][0]).toBe('u1');
    expect(tasksService.list.mock.calls[0][1]).toMatchObject({ view: 'assigned', state: 'closed', q: 'books' });
  });
  it('defaults to My tasks', async () => {
    await request(app).get('/api/service/tasks').set(as('u1'));
    expect(tasksService.list.mock.calls[0][1]).toMatchObject({ view: 'mine' });
  });
  it('refuses an unknown view', async () => {
    expect((await request(app).get('/api/service/tasks?view=everyone').set(as('u1'))).status).toBe(400);
    expect(tasksService.list).not.toHaveBeenCalled();
  });
  it('opens one task as the acting user', async () => {
    const res = await request(app).get('/api/service/tasks/t1').set(as('u1'));
    expect(res.status).toBe(200);
    expect(tasksService.get).toHaveBeenCalledWith('u1', 't1');
  });
  it('serves the dashboard on its own path, not as a task id', async () => {
    const res = await request(app).get('/api/service/tasks/dashboard').set(as('u1'));
    expect(res.status).toBe(200);
    expect(tasksService.dashboard).toHaveBeenCalledWith('u1', {});
    expect(tasksService.get).not.toHaveBeenCalled();
  });
});

describe('changing a status through the ERP door', () => {
  it('passes the change through as the acting user', async () => {
    const res = await request(app).post('/api/service/tasks/t1/status').set(as('u1')).send({ to: 'date_change_requested', comment: 'Bank closed', dueDate: '2099-01-02', dueTime: '10:00' });
    expect(res.status).toBe(200);
    expect(tasksService.changeStatus).toHaveBeenCalledWith('u1', 't1', { to: 'date_change_requested', comment: 'Bank closed', dueDate: '2099-01-02', dueTime: '10:00' });
  });
  it('refuses an unknown status', async () => {
    expect((await request(app).post('/api/service/tasks/t1/status').set(as('u1')).send({ to: 'finished' })).status).toBe(400);
    expect(tasksService.changeStatus).not.toHaveBeenCalled();
  });
});

describe('who may use the door', () => {
  it('needs the service token', async () => {
    expect((await request(app).get('/api/service/tasks').set('X-Act-As', 'u1')).status).toBe(401);
  });
  it('needs an acting user', async () => {
    expect((await request(app).get('/api/service/tasks').set('Authorization', `Bearer ${TOKEN}`)).status).toBe(400);
  });
  it('refuses an unknown or inactive user', async () => {
    expect((await request(app).get('/api/service/tasks').set(as('gone'))).status).toBe(403);
    expect((await request(app).get('/api/service/tasks/t1').set(as('off'))).status).toBe(403);
    expect(tasksService.list).not.toHaveBeenCalled();
    expect(tasksService.get).not.toHaveBeenCalled();
  });
});
