// No DB. Time-zone helpers behind due dates, quiet hours, the 4-working-hour nudge and repeats.
import { inQuietHours, localParts, nextOccurrence, shortStamp, tzForBranchCode, workingMsBetween, zonedDateTime } from '../task.time';

const IST = 'Asia/Kolkata';
const H = 3_600_000;

describe('zones', () => {
  it('maps branch codes to zones, India by default', () => {
    expect(tzForBranchCode('NBO')).toBe('Africa/Nairobi');
    expect(tzForBranchCode('fbm')).toBe('Africa/Lubumbashi');
    expect(tzForBranchCode('BOM')).toBe(IST);
    expect(tzForBranchCode(null)).toBe(IST);
  });
  it('6 pm local is the right instant', () => {
    expect(zonedDateTime('2026-11-18', '18:00', IST).toISOString()).toBe('2026-11-18T12:30:00.000Z');
    expect(zonedDateTime('2026-11-18', '18:00', 'Africa/Nairobi').toISOString()).toBe('2026-11-18T15:00:00.000Z');
    expect(zonedDateTime('2026-11-18', '00:30', IST).toISOString()).toBe('2026-11-17T19:00:00.000Z');
  });
  it('reads the wall clock back', () => {
    expect(localParts(new Date('2026-11-18T19:00:00.000Z'), IST)).toEqual({ dayKey: '2026-11-19', hour: 0, minute: 30, weekday: 4 });
  });
  it('formats the chat stamp like the spec', () => {
    expect(shortStamp(new Date('2026-11-18T10:42:00.000Z'), IST)).toBe('18 Nov, 4:12 pm');
  });
});

describe('quiet hours 10 pm – 7 am', () => {
  it('is quiet at 10:30 pm and 6:59 am, not at 7:00 am', () => {
    expect(inQuietHours(zonedDateTime('2026-11-18', '22:30', IST), IST)).toBe(true);
    expect(inQuietHours(zonedDateTime('2026-11-18', '06:59', IST), IST)).toBe(true);
    expect(inQuietHours(zonedDateTime('2026-11-18', '07:00', IST), IST)).toBe(false);
  });
  it('uses the recipient zone', () => {
    // 21:30 IST = 19:00 Nairobi: quiet in India, not in Kenya
    const at = zonedDateTime('2026-11-18', '22:30', IST);
    expect(inQuietHours(at, 'Africa/Nairobi')).toBe(false);
  });
});

describe('working hours (Mon–Sat 10:00–19:00)', () => {
  it('Saturday 6 pm to Monday 11 am is 2 working hours (Sunday off)', () => {
    const from = zonedDateTime('2026-11-21', '18:00', IST); // Saturday
    const to = zonedDateTime('2026-11-23', '11:00', IST); // Monday
    expect(workingMsBetween(from, to, IST)).toBe(2 * H);
  });
  it('a task assigned at night starts counting at 10 am', () => {
    const from = zonedDateTime('2026-11-18', '23:00', IST);
    const to = zonedDateTime('2026-11-19', '14:00', IST);
    expect(workingMsBetween(from, to, IST)).toBe(4 * H);
  });
  it('is zero for a reversed range', () => {
    expect(workingMsBetween(new Date('2026-11-19'), new Date('2026-11-18'), IST)).toBe(0);
  });
});

describe('repeats keep the local time', () => {
  const mon6pm = zonedDateTime('2026-11-16', '18:00', IST);
  it('daily', () => expect(nextOccurrence(mon6pm, { kind: 'daily' }, IST)?.toISOString()).toBe('2026-11-17T12:30:00.000Z'));
  it('weekly Mon + Thu from Monday → Thursday', () => {
    expect(nextOccurrence(mon6pm, { kind: 'weekly', days: [1, 4] }, IST)?.toISOString()).toBe('2026-11-19T12:30:00.000Z');
  });
  it('weekly Mon only → next Monday', () => {
    expect(nextOccurrence(mon6pm, { kind: 'weekly', days: [1] }, IST)?.toISOString()).toBe('2026-11-23T12:30:00.000Z');
  });
  it('monthly on the 31st clamps to the end of February', () => {
    const jan31 = zonedDateTime('2026-01-31', '18:00', IST);
    expect(nextOccurrence(jan31, { kind: 'monthly', dayOfMonth: 31 }, IST)?.toISOString()).toBe('2026-02-28T12:30:00.000Z');
    const feb28 = zonedDateTime('2026-02-28', '18:00', IST);
    expect(nextOccurrence(feb28, { kind: 'monthly', dayOfMonth: 31 }, IST)?.toISOString()).toBe('2026-03-31T12:30:00.000Z');
  });
  it('none / empty weekly → no next copy', () => {
    expect(nextOccurrence(mon6pm, { kind: 'none' }, IST)).toBeNull();
    expect(nextOccurrence(mon6pm, { kind: 'weekly', days: [] }, IST)).toBeNull();
  });
});
