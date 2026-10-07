import { withHrDayStates } from '../historyStates';
import type { HrDayState } from '../myMonth.service';

const entries = [
  { date: '2026-10-05', inTime: '2026-10-05T05:25:00.000Z' },
  { date: '2026-10-04', inTime: null },
  { date: '2026-10-02', inTime: null },
  { date: '2026-09-30', inTime: '2026-09-30T05:20:00.000Z' },
];

const states = new Map<string, HrDayState>([
  ['2026-10-05', { state: 'present', holiday: null, halfLeave: false }],
  ['2026-10-04', { state: 'weekOff', holiday: null, halfLeave: false }],
  ['2026-10-02', { state: 'holiday', holiday: 'Gandhi Jayanti', halfLeave: false }],
  ['2026-09-30', { state: 'present', holiday: null, halfLeave: false }],
]);

describe('withHrDayStates', () => {
  it('stamps each history entry with its HR state, asking once for the whole window', async () => {
    const calls: [string, string, string][] = [];
    const out = await withHrDayStates('u1', entries, async (u, from, to) => { calls.push([u, from, to]); return states; });
    expect(calls).toEqual([['u1', '2026-09-30', '2026-10-05']]);
    expect(out.map((e) => e.state)).toEqual(['present', 'weekOff', 'holiday', 'present']);
    expect(out[2].holidayName).toBe('Gandhi Jayanti');
    expect(out[0].inTime).toBe(entries[0].inTime); // the punch fields are untouched
  });

  it('leaves a day the HR read does not cover as it was', async () => {
    const out = await withHrDayStates('u1', entries, async () => new Map([['2026-10-04', states.get('2026-10-04') as HrDayState]]));
    expect(out[1].state).toBe('weekOff');
    expect(out[0].state).toBeUndefined();
  });

  it('never fails the list when the HR read fails', async () => {
    const out = await withHrDayStates('u1', entries, async () => { throw new Error('db down'); });
    expect(out).toEqual(entries);
  });

  it('skips the HR read for an empty list', async () => {
    const out = await withHrDayStates('u1', [], async () => { throw new Error('should not be called'); });
    expect(out).toEqual([]);
  });
});
