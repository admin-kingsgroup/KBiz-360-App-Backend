import { withHrDayStates } from '../historyStates';
import type { HrDayState } from '../myMonth.service';

const entries = [
  { date: '2026-10-05', inTime: '2026-10-05T05:25:00.000Z' },
  { date: '2026-10-04', inTime: null },
  { date: '2026-10-02', inTime: null },
  { date: '2026-09-30', inTime: '2026-09-30T05:20:00.000Z' },
];

const st = (state: HrDayState['state'], over: Partial<HrDayState> = {}): HrDayState => ({ state, holiday: null, halfLeave: false, weekOff: state === 'weekOff', wfh: false, swap: '', ...over });
const states = new Map<string, HrDayState>([
  ['2026-10-05', st('present')],
  ['2026-10-04', st('weekOff')],
  ['2026-10-02', st('holiday', { holiday: 'Gandhi Jayanti' })],
  ['2026-09-30', st('present')],
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

  it('carries work from home and a swapped Saturday — the week-off flag follows the swap, not the bare rule', async () => {
    const list = [
      { date: '2026-10-17', inTime: null, weekOff: true },   // own week-off Saturday, swapped to a working day
      { date: '2026-10-14', inTime: null, weekOff: false },  // approved WFH
      { date: '2026-10-10', inTime: null, weekOff: false },  // working Saturday, swapped to a week off
    ];
    const out = await withHrDayStates('u1', list, async () => new Map([
      ['2026-10-17', st('absent', { swap: 'work' })],
      ['2026-10-14', st('present', { wfh: true })],
      ['2026-10-10', st('weekOff', { swap: 'off' })],
    ]));
    expect(out.map((e) => [e.date, e.state, e.weekOff, e.wfh, e.swap])).toEqual([
      ['2026-10-17', 'absent', false, false, 'work'],
      ['2026-10-14', 'present', false, true, ''],
      ['2026-10-10', 'weekOff', true, false, 'off'],
    ]);
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
