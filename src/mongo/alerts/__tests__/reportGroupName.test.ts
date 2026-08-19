import { reportGroupExpected, reportGroupKey, reportGroupKeys, isReportGroupFor, squashName } from '../reportGroupName';

// Pure unit tests — no DB. The routing rule for every report the backends post into a group chat:
// which group a branch's message belongs in. Getting this wrong is not a cosmetic bug — it would
// put one branch's ledger balances, or its people's attendance, in another branch's room.

describe('finance group routing', () => {
  it('matches however the group name was punctuated', () => {
    for (const name of ['HQ - BOM Finance', 'HQ-BOM Finance', 'HQ  -  BOM   Finance', 'hq bom finance']) {
      expect(isReportGroupFor(name, 'finance', 'BOM')).toBe(true);
    }
  });

  it('is case-insensitive on the branch code too', () => {
    expect(isReportGroupFor('HQ - NBO Finance', 'finance', 'nbo')).toBe(true);
    expect(isReportGroupFor('HQ - NBO Finance', 'finance', ' NBO ')).toBe(true);
  });

  it('never matches another branch, or a differently-scoped group', () => {
    expect(isReportGroupFor('HQ - AMD Finance', 'finance', 'BOM')).toBe(false);
    expect(isReportGroupFor('HO - QA Finance', 'finance', 'QA')).toBe(false);
    expect(isReportGroupFor('BOM - Branch Accounts', 'finance', 'BOM')).toBe(false);
    // A code that merely SITS INSIDE the name is not a match — the BOM/BOMMB substring trap.
    expect(isReportGroupFor('HQ - BOMMB Finance', 'finance', 'BOM')).toBe(false);
    expect(isReportGroupFor('HQ - BOM Finance', 'finance', 'BOMMB')).toBe(false);
  });

  it('refuses a blank branch code rather than matching something', () => {
    expect(isReportGroupFor('HQ -  Finance', 'finance', '')).toBe(false);
    expect(isReportGroupFor(null, 'finance', 'BOM')).toBe(false);
    expect(isReportGroupFor(undefined, 'finance', 'BOM')).toBe(false);
  });

  it('a new branch needs no code change — the key is derived from its code', () => {
    expect(reportGroupKey('finance', 'DXB')).toBe('hqdxbfinance');
    expect(isReportGroupFor('HQ - DXB Finance', 'finance', 'DXB')).toBe(true);
  });

  it('squashes to letters and digits only', () => {
    expect(squashName('HQ - BOM Finance')).toBe('hqbomfinance');
    expect(squashName('')).toBe('');
  });
});

// The hub reports into a group that predates the HQ set, so the finance family accepts two shapes.
describe('the hub group', () => {
  it('accepts "MHUB - Finance Team" for MHUB, and only for MHUB', () => {
    expect(isReportGroupFor('MHUB - Finance Team', 'finance', 'MHUB')).toBe(true);
    expect(isReportGroupFor('MHUB - Finance Team', 'finance', 'BOM')).toBe(false);
    expect(reportGroupKeys('finance', 'MHUB')).toEqual(['hqmhubfinance', 'mhubfinanceteam']);
  });

  it('still prefers the HQ name where both could exist', () => {
    expect(reportGroupKey('finance', 'BOM')).toBe('hqbomfinance');
    expect(isReportGroupFor('BOM - Finance Team', 'finance', 'BOM')).toBe(true);
    expect(isReportGroupFor('BOM - Branch Accounts', 'finance', 'BOM')).toBe(false);
  });
});

// The per-voucher money-movement feed goes to a DIFFERENT room than the daily reports.
describe('accounts group routing', () => {
  it('matches "<CODE> - Branch Accounts", however punctuated', () => {
    for (const name of ['BOM - Branch Accounts', 'BOM-Branch Accounts', 'bom  branch  accounts']) {
      expect(isReportGroupFor(name, 'accounts', 'BOM')).toBe(true);
    }
    expect(reportGroupKeys('accounts', 'NBO')).toEqual(['nbobranchaccounts']);
  });

  it('the two families never cross', () => {
    expect(isReportGroupFor('HQ - BOM Finance', 'accounts', 'BOM')).toBe(false);
    expect(isReportGroupFor('BOM - Branch Accounts', 'accounts', 'AMD')).toBe(false);
    expect(isReportGroupFor('MHUB - Finance Team', 'accounts', 'MHUB')).toBe(false);
  });

  it('says which group it expected when there is none', () => {
    expect(reportGroupExpected('accounts', 'DAR')).toBe('"DAR - Branch Accounts"');
    expect(reportGroupExpected('finance', 'DAR')).toBe('"HQ - DAR Finance" or "DAR - Finance Team"');
  });
});
