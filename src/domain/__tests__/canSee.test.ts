import { makeCanSee } from '../logic/canSee';
import { PERSON_META, ROLE_VIEWERS } from '../data/users';

const see = (role: keyof typeof ROLE_VIEWERS) => makeCanSee(ROLE_VIEWERS[role], PERSON_META);
// PERSON_META ids: a(super) fa(dir) p(gm AMD,BOM) f(bm AMD) m(hod AMD/Accounts)
//                  r(emp AMD/Ticketing) sn(emp BOM/Accounts) ko(emp NBO/Holidays) an(emp BOM/MKTG)

describe('canSee — hierarchy + scope', () => {
  it('SUPER_ADMIN sees everyone', () => {
    const s = see('SUPER_ADMIN');
    ['fa', 'p', 'f', 'm', 'r', 'sn', 'ko', 'an'].forEach((id) => expect(s(id)).toBe(true));
    expect(s('a')).toBe(true); // own
  });

  it('DIRECTOR sees all strictly-below business-wide, not peers/self-rank', () => {
    const s = see('DIRECTOR');
    expect(s('p')).toBe(true);   // GM
    expect(s('f')).toBe(true);   // BM
    expect(s('m')).toBe(true);   // HOD
    expect(s('an')).toBe(true);  // employee BOM
    expect(s('ko')).toBe(true);  // employee NBO
    expect(s('a')).toBe(false);  // super is above → not visible
    expect(s('fa')).toBe(true);  // own id
  });

  it('GENERAL_MANAGER (AMD,BOM) sees BM/HOD/staff only in overlapping branches', () => {
    const s = see('GENERAL_MANAGER');
    expect(s('f')).toBe(true);   // BM AMD
    expect(s('m')).toBe(true);   // HOD AMD
    expect(s('r')).toBe(true);   // emp AMD
    expect(s('sn')).toBe(true);  // emp BOM
    expect(s('an')).toBe(true);  // emp BOM
    expect(s('ko')).toBe(false); // emp NBO — out of branch scope
    expect(s('fa')).toBe(false); // director is above
  });

  it('BRANCH_MANAGER (AMD) sees only HOD/staff in AMD', () => {
    const s = see('BRANCH_MANAGER');
    expect(s('m')).toBe(true);   // HOD AMD
    expect(s('r')).toBe(true);   // emp AMD
    expect(s('sn')).toBe(false); // emp BOM
    expect(s('ko')).toBe(false); // emp NBO
    expect(s('p')).toBe(false);  // GM above
  });

  it('HOD (AMD/Accounts) sees only employees in same dept AND branch', () => {
    const s = see('HOD');
    expect(s('r')).toBe(false);  // emp AMD but Ticketing dept → no
    expect(s('sn')).toBe(false); // Accounts dept but BOM branch → no
    expect(s('m')).toBe(true);   // own id
  });

  it('EMPLOYEE sees only their own', () => {
    const s = see('EMPLOYEE'); // viewer id 'r'
    expect(s('r')).toBe(true);
    ['a', 'fa', 'p', 'f', 'm', 'sn', 'ko', 'an'].forEach((id) => expect(s(id)).toBe(false));
  });
});
