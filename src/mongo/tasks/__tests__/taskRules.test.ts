// No DB. The task status machine (spec §4 + owner's answers 2026-11-16).
import { allowedTransitions, isOverdue, planTransition, type RuleTask } from '../task.rules';
import type { TaskStatus } from '../task.types';

const NOW = new Date('2026-11-18T10:00:00.000Z');
const LATER = new Date('2026-11-20T12:30:00.000Z');
const task = (status: TaskStatus, over: Partial<RuleTask> = {}): RuleTask => ({ status, assignedBy: 'afshin', assignedTo: 'satish', ...over });

describe('who may move a task', () => {
  const rows: Array<[TaskStatus, TaskStatus, 'satish' | 'afshin']> = [
    ['assigned', 'accepted', 'satish'],
    ['assigned', 'date_change_requested', 'satish'],
    ['date_change_requested', 'accepted', 'afshin'],
    ['accepted', 'in_progress', 'satish'],
    ['in_progress', 'waiting', 'satish'],
    ['in_progress', 'done', 'satish'],
    ['waiting', 'in_progress', 'satish'],
    ['waiting', 'done', 'satish'],
    ['reopened', 'in_progress', 'satish'],
    ['done', 'closed', 'afshin'],
    ['done', 'reopened', 'afshin'],
    ['closed', 'reopened', 'afshin'],
    ['assigned', 'cancelled', 'afshin'],
    ['in_progress', 'cancelled', 'afshin'],
    ['reopened', 'cancelled', 'afshin'],
  ];
  it.each(rows)('%s → %s is allowed for %s and refused for the other side', (from, to, who) => {
    const other = who === 'satish' ? 'afshin' : 'satish';
    expect(allowedTransitions(task(from), who)).toContain(to);
    expect(allowedTransitions(task(from), other)).not.toContain(to);
    const input = { comment: 'because', dueAt: LATER };
    expect(() => planTransition(task(from, { requestedDueAt: LATER }), who, to, input, NOW)).not.toThrow();
    expect(() => planTransition(task(from, { requestedDueAt: LATER }), other, to, input, NOW)).toThrow(/Only the person/);
  });

  it('the assignee cannot close their own task', () => {
    expect(allowedTransitions(task('done'), 'satish')).toEqual([]);
    expect(() => planTransition(task('done'), 'satish', 'closed', {}, NOW)).toThrow(/Only the person who assigned/);
  });

  it('a watcher or anyone else has no buttons', () => {
    expect(allowedTransitions(task('in_progress'), 'shehzad')).toEqual([]);
  });

  it('refuses a move that does not exist', () => {
    expect(() => planTransition(task('assigned'), 'satish', 'done', {}, NOW)).toThrow(/cannot move/);
    expect(() => planTransition(task('cancelled'), 'afshin', 'reopened', { comment: 'x' }, NOW)).toThrow(/cannot move/);
  });
});

describe('comments and dates', () => {
  it('cancelling needs a reason', () => {
    expect(() => planTransition(task('assigned'), 'afshin', 'cancelled', {}, NOW)).toThrow(/reason/);
  });
  it('waiting needs to say who or what', () => {
    expect(() => planTransition(task('in_progress'), 'satish', 'waiting', { comment: '  ' }, NOW)).toThrow(/waiting on/);
    expect(planTransition(task('in_progress'), 'satish', 'waiting', { comment: 'Bank statement from HDFC' }, NOW).set.waitingOn)
      .toBe('Bank statement from HDFC');
  });
  it('a date change request needs a reason and a future date', () => {
    expect(() => planTransition(task('assigned'), 'satish', 'date_change_requested', { comment: 'month end' }, NOW)).toThrow(/new due date/);
    expect(() => planTransition(task('assigned'), 'satish', 'date_change_requested', { comment: 'x', dueAt: new Date('2026-11-01') }, NOW)).toThrow(/past/);
    const plan = planTransition(task('assigned'), 'satish', 'date_change_requested', { comment: 'month end', dueAt: LATER }, NOW);
    expect(plan.set.requestedDueAt).toEqual(LATER);
  });
  it('approving a date change moves the due date to the requested one and re-arms the alerts', () => {
    const plan = planTransition(task('date_change_requested', { requestedDueAt: LATER }), 'afshin', 'accepted', {}, NOW);
    expect(plan.set.dueAt).toEqual(LATER);
    expect(plan.set.requestedDueAt).toBeNull();
    expect(plan.set['alerts.overdueAt']).toBeNull();
  });
  it('the assigner can set a different date while approving', () => {
    const other = new Date('2026-11-25T12:30:00.000Z');
    expect(planTransition(task('date_change_requested', { requestedDueAt: LATER }), 'afshin', 'accepted', { dueAt: other }, NOW).set.dueAt).toEqual(other);
  });
});

describe('a task you set for yourself', () => {
  const self = (status: TaskStatus): RuleTask => task(status, { assignedBy: 'satish', assignedTo: 'satish' });
  it('Done closes it directly', () => {
    const plan = planTransition(self('in_progress'), 'satish', 'done', {}, NOW);
    expect(plan.status).toBe('closed');
    expect(plan.set.doneAt).toEqual(NOW);
    expect(plan.set.closedAt).toEqual(NOW);
  });
  it('can be ticked off straight from Accepted', () => {
    expect(allowedTransitions(self('accepted'), 'satish')).toEqual(expect.arrayContaining(['in_progress', 'done', 'cancelled']));
    expect(planTransition(self('accepted'), 'satish', 'done', {}, NOW).status).toBe('closed');
  });
  it('has no date change request (you just edit the date)', () => {
    expect(allowedTransitions(self('assigned'), 'satish')).not.toContain('date_change_requested');
  });
});

describe('overdue flag', () => {
  it('open work past its due time is overdue', () => {
    expect(isOverdue({ status: 'in_progress', dueAt: new Date('2026-11-18T09:00:00.000Z') }, NOW)).toBe(true);
    expect(isOverdue({ status: 'in_progress', dueAt: LATER }, NOW)).toBe(false);
  });
  it('done, closed and cancelled are never overdue', () => {
    for (const s of ['done', 'closed', 'cancelled'] as TaskStatus[]) expect(isOverdue({ status: s, dueAt: new Date('2026-11-01') }, NOW)).toBe(false);
  });
  it('converted task without dueAt is never overdue', () => {
    expect(isOverdue({ status: 'accepted', dueAt: null }, NOW)).toBe(false);
  });
});
