import { planRegularization } from '../regularization.service';
import { leaveApplySchema, regularizationSchema, regularizationDecisionSchema } from '../hr.router';

// planRegularization = the pure gate every request passes before anything is stored. Times ride
// the same resolveAdminTimes bounds the admin editor uses; these cases pin the request-side rules.
// Instants below are UTC for an IST business day (ATTENDANCE_TZ default): 04:10Z = 9:40 IST.

const NOW = new Date('2026-09-08T10:00:00Z'); // 15:30 IST → business day 2026-09-08

describe('planRegularization', () => {
  const body = {
    date: '2026-09-05',
    checkInAt: '2026-09-05T04:10:00.000Z',
    checkOutAt: '2026-09-05T13:00:00.000Z',
    reason: 'Geofence never fired — I was at the office by 9:40',
  };

  it('accepts a bounded past-day request and normalises the reason', () => {
    const plan = planRegularization({ ...body, reason: `  ${body.reason}  ` }, NOW);
    expect(plan.date).toBe('2026-09-05');
    expect(plan.checkInAt.toISOString()).toBe('2026-09-05T04:10:00.000Z');
    expect(plan.checkOutAt?.toISOString()).toBe('2026-09-05T13:00:00.000Z');
    expect(plan.reason).toBe(body.reason);
  });

  it('refuses future days, the deep past, and a missing reason', () => {
    expect(() => planRegularization({ ...body, date: '2026-09-09' }, NOW)).toThrow(/has not happened yet/);
    expect(() => planRegularization({ ...body, date: '2026-07-01', checkInAt: '2026-07-01T04:10:00.000Z', checkOutAt: '2026-07-01T13:00:00.000Z' }, NOW)).toThrow(/too far back/);
    expect(() => planRegularization({ ...body, reason: '   ' }, NOW)).toThrow(/Say why/);
  });

  it('rides resolveAdminTimes: out after in, on the day, past days never open', () => {
    expect(() => planRegularization({ ...body, checkOutAt: '2026-09-05T04:00:00.000Z' }, NOW)).toThrow(/after check-in/);
    expect(() => planRegularization({ ...body, checkInAt: '2026-09-04T04:10:00.000Z' }, NOW)).toThrow(/must fall on 2026-09-05/);
    expect(() => planRegularization({ ...body, checkOutAt: null }, NOW)).toThrow(/only today can be left open/);
  });

  it('today may be left open', () => {
    const plan = planRegularization(
      { date: '2026-09-08', checkInAt: '2026-09-08T04:10:00.000Z', checkOutAt: null, reason: 'forgot to punch in' },
      NOW,
    );
    expect(plan.checkOutAt).toBeNull();
  });
});

// validate() strips unknown keys — every field must be declared or it silently vanishes.
describe('router schemas', () => {
  it('leave apply keeps from/to/reason and trims nothing silently', () => {
    const parsed = leaveApplySchema.parse({ from: '2026-09-10', to: '2026-09-11', reason: 'family function' });
    expect(parsed).toEqual({ from: '2026-09-10', to: '2026-09-11', reason: 'family function' });
    expect(() => leaveApplySchema.parse({ from: '10-09-2026', to: '2026-09-11', reason: 'x' })).toThrow();
  });

  it('regularization keeps checkOutAt:null (an explicit "leave today open")', () => {
    const parsed = regularizationSchema.parse({
      date: '2026-09-08',
      checkInAt: '2026-09-08T04:10:00.000Z',
      checkOutAt: null,
      reason: 'forgot to punch in',
    });
    expect(parsed.checkOutAt).toBeNull();
  });

  it('decision requires a known action; note is optional at the schema (reject enforces it in the service)', () => {
    expect(regularizationDecisionSchema.parse({ action: 'approve' })).toEqual({ action: 'approve' });
    expect(() => regularizationDecisionSchema.parse({ action: 'undo' })).toThrow();
  });
});
