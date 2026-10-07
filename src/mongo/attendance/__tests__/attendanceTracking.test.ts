// Owner 2026-10-07: "every user marks attendance except Afshin". Being a super-admin no longer
// excuses anyone — the per-user attendance_exempt list is the only opt-out, and a HIDDEN (director)
// account is always tracked. No DB: the two lists are stubbed.
const exemptIds = new Set<string>(['owner']);
const hiddenIds = new Set<string>();
jest.mock('../../attendanceExempt', () => ({ attendanceExempt: { isExempt: async (id: string) => exemptIds.has(id) } }));
jest.mock('../../attendanceHidden', () => ({ attendanceHidden: { isHidden: async (id: string) => hiddenIds.has(id) } }));

import { isUntracked } from '../attendance.service';

describe('who marks attendance', () => {
  afterEach(() => { hiddenIds.clear(); });

  it('a super-admin who is not on the exempt list marks attendance', async () => {
    expect(await isUntracked('some-super-admin')).toBe(false);
  });

  it('staff mark attendance', async () => {
    expect(await isUntracked('staff')).toBe(false);
  });

  it('only the exempt list excuses someone', async () => {
    expect(await isUntracked('owner')).toBe(true);
  });

  it('a hidden director is tracked even when on the exempt list', async () => {
    hiddenIds.add('owner');
    expect(await isUntracked('owner')).toBe(false);
  });
});
