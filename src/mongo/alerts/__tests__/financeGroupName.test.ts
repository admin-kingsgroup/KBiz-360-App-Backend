import { financeGroupKey, financeGroupKeys, isFinanceGroupFor, squashName } from '../financeGroupName';

// Pure unit tests — no DB. The routing rule for the scheduled finance reports: which group chat
// a branch's Receivables / Payables / Bank & Cash posts belong in. Getting this wrong is not a
// cosmetic bug — it would put one branch's ledger balances in another branch's group.

describe('finance group routing', () => {
  it('matches however the group name was punctuated', () => {
    for (const name of ['HQ - BOM Finance', 'HQ-BOM Finance', 'HQ  -  BOM   Finance', 'hq bom finance']) {
      expect(isFinanceGroupFor(name, 'BOM')).toBe(true);
    }
  });

  it('is case-insensitive on the branch code too', () => {
    expect(isFinanceGroupFor('HQ - NBO Finance', 'nbo')).toBe(true);
    expect(isFinanceGroupFor('HQ - NBO Finance', ' NBO ')).toBe(true);
  });

  it('never matches another branch, or a differently-scoped finance group', () => {
    expect(isFinanceGroupFor('HQ - AMD Finance', 'BOM')).toBe(false);
    expect(isFinanceGroupFor('HO - QA Finance', 'QA')).toBe(false);
    expect(isFinanceGroupFor('BOM - Branch Accounts', 'BOM')).toBe(false);
    // A code that merely SITS INSIDE the name is not a match — the BOM/BOMMB substring trap.
    expect(isFinanceGroupFor('HQ - BOMMB Finance', 'BOM')).toBe(false);
    expect(isFinanceGroupFor('HQ - BOM Finance', 'BOMMB')).toBe(false);
  });

  it('refuses a blank branch code rather than matching something', () => {
    expect(isFinanceGroupFor('HQ -  Finance', '')).toBe(false);
    expect(isFinanceGroupFor(null, 'BOM')).toBe(false);
    expect(isFinanceGroupFor(undefined, 'BOM')).toBe(false);
  });

  it('a new branch needs no code change — the key is derived from its code', () => {
    expect(financeGroupKey('DXB')).toBe('hqdxbfinance');
    expect(isFinanceGroupFor('HQ - DXB Finance', 'DXB')).toBe(true);
  });

  it('squashes to letters and digits only', () => {
    expect(squashName('HQ - BOM Finance')).toBe('hqbomfinance');
    expect(squashName('')).toBe('');
  });
});

// The hub reports into a group that predates the HQ set, so the resolver accepts two shapes.
describe('the hub group', () => {
  it('accepts "MHUB - Finance Team" for MHUB, and only for MHUB', () => {
    expect(isFinanceGroupFor('MHUB - Finance Team', 'MHUB')).toBe(true);
    expect(isFinanceGroupFor('MHUB - Finance Team', 'BOM')).toBe(false);
    expect(financeGroupKeys('MHUB')).toEqual(['hqmhubfinance', 'mhubfinanceteam']);
  });

  it('still prefers the HQ name where both could exist', () => {
    expect(financeGroupKey('BOM')).toBe('hqbomfinance');
    expect(isFinanceGroupFor('HQ - BOM Finance', 'BOM')).toBe(true);
    expect(isFinanceGroupFor('BOM - Finance Team', 'BOM')).toBe(true);
    expect(isFinanceGroupFor('BOM - Branch Accounts', 'BOM')).toBe(false);
  });
});
