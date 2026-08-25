import { punchChatLine, punchDedupeKey } from '../punchMessage';

describe('punchChatLine (the line a branch group sees, pure)', () => {
  it('reads as a sentence with the wall clock and the method', () => {
    expect(punchChatLine({ name: 'Priya Patel', action: 'in', time: '9:42 AM', via: 'Geofence' }))
      .toBe('🟢 Priya Patel checked in · 9:42 AM · Geofence');
  });

  it('marks a departure differently from an arrival', () => {
    expect(punchChatLine({ name: 'Rahul Sharma', action: 'out', time: '7:04 PM', via: 'Face' }))
      .toBe('🔴 Rahul Sharma checked out · 7:04 PM · Face');
  });

  // fmtTime returns null on a bad zone and `method` can be missing on an old record — neither may
  // produce a dangling separator in a room full of people.
  it('drops an unknown time or method instead of leaving empty separators', () => {
    expect(punchChatLine({ name: 'Asha', action: 'in', time: null, via: null })).toBe('🟢 Asha checked in');
    expect(punchChatLine({ name: 'Asha', action: 'in', time: '9:42 AM' })).toBe('🟢 Asha checked in · 9:42 AM');
  });

  // nameOf falls back to the email and, failing that, 'Unknown' — but a blank CRM row must still
  // read as a person, never as "  checked in".
  it('never posts a nameless line', () => {
    expect(punchChatLine({ name: '   ', action: 'in', time: '9:42 AM' })).toBe('🟢 Someone checked in · 9:42 AM');
  });
});

describe('punchDedupeKey (one line per person per direction per day)', () => {
  it('collapses a re-entry into the arrival already posted', () => {
    const first = punchDedupeKey('BOM', '2026-08-25', 'u1', 'in');
    const reentry = punchDedupeKey('BOM', '2026-08-25', 'u1', 'in');
    expect(reentry).toBe(first);
  });

  it('keeps the arrival and the departure apart', () => {
    expect(punchDedupeKey('BOM', '2026-08-25', 'u1', 'in'))
      .not.toBe(punchDedupeKey('BOM', '2026-08-25', 'u1', 'out'));
  });

  it('keeps different people, days and branches apart', () => {
    const base = punchDedupeKey('BOM', '2026-08-25', 'u1', 'in');
    expect(punchDedupeKey('BOM', '2026-08-25', 'u2', 'in')).not.toBe(base);
    expect(punchDedupeKey('BOM', '2026-08-26', 'u1', 'in')).not.toBe(base);
    expect(punchDedupeKey('AMD', '2026-08-25', 'u1', 'in')).not.toBe(base);
  });

  // The day-close summary keys on `attendance-<BR>-<day>`; a punch key that collided with it would
  // suppress that branch's whole nightly report.
  it('cannot collide with the day-close report key', () => {
    expect(punchDedupeKey('BOM', '2026-08-25', 'u1', 'in')).not.toBe('attendance-BOM-2026-08-25');
  });
});
