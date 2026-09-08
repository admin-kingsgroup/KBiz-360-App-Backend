import { applyNoData, buildMonth, classifyDay, isWeekOffDay, monthDayKeys, summarizeMonth, type DayRecord } from '../attendanceMonth';

// Parity suite for the ERP's employeeAttendance.service classifier — the precedence and the
// week-off policy must read every day exactly as the ERP report does.

const punch = (inH: string, outH: string | null, extra: Partial<DayRecord> = {}): DayRecord => ({
  checkInAt: new Date(`2026-09-03T${inH}:00.000Z`),
  checkOutAt: outH ? new Date(`2026-09-03T${outH}:00.000Z`) : null,
  method: 'Face',
  present: !outH,
  ...extra,
});

describe('monthDayKeys', () => {
  it('walks the calendar (leap February included)', () => {
    expect(monthDayKeys('2026-09')).toHaveLength(30);
    expect(monthDayKeys('2028-02')).toHaveLength(29);
    expect(monthDayKeys('junk')).toEqual([]);
  });
});

describe('isWeekOffDay', () => {
  it('default policy = Sunday only', () => {
    expect(isWeekOffDay('2026-09-06')).toBe(true); // Sunday
    expect(isWeekOffDay('2026-09-05')).toBe(false); // Saturday
  });
  it('Saturday rules: odd = 1st/3rd/5th, even = 2nd/4th', () => {
    const odd = { days: [0], saturdays: 'odd' };
    const even = { days: [0], saturdays: 'even' };
    expect(isWeekOffDay('2026-09-05', odd)).toBe(true); // 1st Saturday
    expect(isWeekOffDay('2026-09-12', odd)).toBe(false); // 2nd
    expect(isWeekOffDay('2026-09-12', even)).toBe(true);
    expect(isWeekOffDay('2026-09-19', even)).toBe(false); // 3rd
  });
});

describe('classifyDay precedence (the ERP order, verbatim)', () => {
  const ctx = { today: '2026-09-08' };
  it('punched wins over holiday and week off (worked = present, never late)', () => {
    const d = classifyDay('2026-09-06', { ...ctx, record: punch('04:10', '13:00'), holiday: { name: 'X', kind: 'closed' }, shift: { start: '09:00', graceMinutes: 0 } });
    expect(d.state).toBe('present');
    expect(d.late).toBe(false); // voluntary work on a closed holiday — no late mark
    expect(d.hours).toBeCloseTo(8.83, 2);
  });
  it('admin marked-absent beats holiday / week off / future', () => {
    const d = classifyDay('2026-09-06', { ...ctx, record: { checkInAt: null, checkOutAt: null, method: 'Manual', present: false } });
    expect(d.state).toBe('absent');
    expect(d.markedAbsent).toBe(true);
  });
  it('granted overrides beat future; leave reads as leave', () => {
    expect(classifyDay('2026-09-20', { ...ctx, override: { state: 'weekOff' } }).state).toBe('weekOff');
    expect(classifyDay('2026-09-20', { ...ctx, override: { state: 'optionalHoliday' } }).state).toBe('holiday');
    const leave = classifyDay('2026-09-04', { ...ctx, override: { state: 'leave' } });
    expect(leave.state).toBe('leave');
    expect(leave.onLeave).toBe(true);
    expect(leave.granted).toBe(true);
  });
  it('future → closed holiday → weekly-off policy → absent', () => {
    expect(classifyDay('2026-09-20', ctx).state).toBe('future');
    expect(classifyDay('2026-09-04', { ...ctx, holiday: { name: 'X', kind: 'closed' } }).state).toBe('holiday');
    expect(classifyDay('2026-09-06', ctx).state).toBe('weekOff');
    expect(classifyDay('2026-09-04', ctx).state).toBe('absent');
  });
  it('outside the employment window → notEmployed', () => {
    expect(classifyDay('2026-09-04', { ...ctx, employment: { dateOfJoining: '2026-09-10' } }).state).toBe('notEmployed');
  });
  it('late marks respect grace on the business clock', () => {
    // Shift 09:30 IST = 04:00Z; check-in 04:20Z = 09:50 IST → 20 minutes after start.
    const d = classifyDay('2026-09-03', { ...ctx, record: punch('04:20', '13:00'), shift: { start: '09:30', graceMinutes: 15 } });
    expect(d.late).toBe(true);
    expect(d.lateMinutes).toBe(20);
    const inGrace = classifyDay('2026-09-03', { ...ctx, record: punch('04:10', '13:00'), shift: { start: '09:30', graceMinutes: 15 } });
    expect(inGrace.late).toBe(false);
  });
});

describe('applyNoData + summarizeMonth', () => {
  it('blank days before the first-ever punch are noData, never absent — and never docked', () => {
    const days = buildMonth('2026-09', { today: '2026-09-08', recordsByDay: new Map([['2026-09-03', punch('04:10', '13:00')]]) });
    const withEvidence = applyNoData(days, { firstPunchDay: '2026-09-03' });
    const s = summarizeMonth(withEvidence);
    // 1st, 2nd blank (before first punch) → noData; 4th, 7th, 8th blank after it → absent
    // (6th is Sunday; 5th Saturday is working under the default policy).
    expect(s.noData).toBe(2);
    expect(s.present).toBe(1);
    expect(s.absent).toBe(4); // 4, 5, 7, 8
    expect(s.weekOffs).toBe(1);
    expect(s.future).toBe(22);
  });
  it('a marked-absent day stays absent even before the first punch', () => {
    const days = buildMonth('2026-09', {
      today: '2026-09-08',
      recordsByDay: new Map<string, DayRecord>([
        ['2026-09-01', { checkInAt: null, checkOutAt: null, method: 'Manual', present: false }],
        ['2026-09-03', punch('04:10', '13:00')],
      ]),
    });
    const s = summarizeMonth(applyNoData(days, { firstPunchDay: '2026-09-03' }));
    expect(s.noData).toBe(1); // only the 2nd
    expect(s.absent).toBe(5); // 1 (marked), 4, 5, 7, 8
  });
});
