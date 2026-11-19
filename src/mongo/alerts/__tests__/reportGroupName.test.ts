import { reportGroupExpected, reportGroupKey, reportGroupKeys, reportGroupNameHint, isReportGroupFor, squashName } from '../reportGroupName';

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
    // A code that merely SITS INSIDE the name is not a match — the short-code substring trap.
    expect(isReportGroupFor('HQ - BOMX Finance', 'finance', 'BOM')).toBe(false);
    expect(isReportGroupFor('HQ - BOM Finance', 'finance', 'BOMX')).toBe(false);
  });

  it('refuses a blank branch code rather than matching something', () => {
    expect(isReportGroupFor('HQ -  Finance', 'finance', '')).toBe(false);
    expect(isReportGroupFor(null, 'finance', 'BOM')).toBe(false);
    expect(isReportGroupFor(undefined, 'finance', 'BOM')).toBe(false);
  });

  it('a new branch needs no code change — the key is derived from its code', () => {
    expect(reportGroupKey('finance', 'DXB')).toBe('accountsdxb');
    expect(isReportGroupFor('Accounts DXB', 'finance', 'DXB')).toBe(true);
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
    expect(reportGroupKeys('finance', 'MHUB')).toEqual(['accountsmhub', 'hqmhubfinance', 'mhubfinanceteam']);
  });

  it('still accepts the HQ name where both could exist', () => {
    expect(reportGroupKey('finance', 'BOM')).toBe('accountsbom');
    expect(isReportGroupFor('HQ - BOM Finance', 'finance', 'BOM')).toBe(true);
    expect(isReportGroupFor('BOM - Finance Team', 'finance', 'BOM')).toBe(true);
    expect(isReportGroupFor('BOM - Branch Accounts', 'finance', 'BOM')).toBe(false);
  });
});

// Attendance (live punches + day-close summary) goes to the branch's HR room, not finance.
describe('hr group routing', () => {
  it('matches every shape a branch HR room gets named in, however punctuated', () => {
    for (const name of ['HQ - BOM HR', 'HQ-BOM HR', 'hq bom hr']) {
      expect(isReportGroupFor(name, 'hr', 'BOM')).toBe(true);
    }
    expect(isReportGroupFor('BOM - HR Team', 'hr', 'BOM')).toBe(true);
    expect(isReportGroupFor('BOM HR', 'hr', 'BOM')).toBe(true);
    expect(isReportGroupFor('MHUB - HR Team', 'hr', 'MHUB')).toBe(true);
    expect(reportGroupKeys('hr', 'NBO')).toEqual(['accountsnbo', 'hqnbohr', 'nbohrteam', 'nbohr']);
  });

  it('never matches another branch or the finance family', () => {
    expect(isReportGroupFor('HQ - AMD HR', 'hr', 'BOM')).toBe(false);
    expect(isReportGroupFor('HQ - BOM Finance', 'hr', 'BOM')).toBe(false);
    expect(isReportGroupFor('HQ - BOM HR', 'finance', 'BOM')).toBe(false);
    expect(isReportGroupFor('HQ - BOMX HR', 'hr', 'BOM')).toBe(false); // the short-code substring trap
  });

  it('says which group it expected when there is none', () => {
    expect(reportGroupExpected('hr', 'DAR')).toBe('"Accounts DAR"');
  });
});

// The per-voucher money-movement feed goes to a DIFFERENT room than the daily reports.
describe('accounts group routing', () => {
  it('matches "<CODE> - Branch Accounts", however punctuated', () => {
    for (const name of ['BOM - Branch Accounts', 'BOM-Branch Accounts', 'bom  branch  accounts']) {
      expect(isReportGroupFor(name, 'accounts', 'BOM')).toBe(true);
    }
    expect(reportGroupKeys('accounts', 'NBO')).toEqual(['accountsnbo', 'nbobranchaccounts']);
  });

  it('the two families never cross', () => {
    expect(isReportGroupFor('HQ - BOM Finance', 'accounts', 'BOM')).toBe(false);
    expect(isReportGroupFor('BOM - Branch Accounts', 'accounts', 'AMD')).toBe(false);
    expect(isReportGroupFor('MHUB - Finance Team', 'accounts', 'MHUB')).toBe(false);
  });

  it('says which group it expected when there is none', () => {
    expect(reportGroupExpected('accounts', 'DAR')).toBe('"Accounts DAR"');
    expect(reportGroupExpected('finance', 'DAR')).toBe('"Accounts DAR"');
  });
});

// Owner, 2026-11-19: every Travkings branch keeps exactly two groups — "Operation <CODE>" and
// "Accounts <CODE>". Accounts takes what the branch's Branch Accounts, HQ Finance and HR rooms got
// (concerns, voucher feed, daily reports, attendance); Operation takes the Ticketing / Holidays
// desk posts. The old names stay accepted so nothing breaks while the groups are being renamed.
describe('Operation / Accounts groups', () => {
  it('"Accounts <CODE>" receives the accounts, finance and hr posts of that branch', () => {
    for (const kind of ['accounts', 'finance', 'hr'] as const) {
      for (const name of ['Accounts BOM', 'Accounts - BOM', 'accounts  bom', 'ACCOUNTS-BOM']) {
        expect(isReportGroupFor(name, kind, 'BOM')).toBe(true);
      }
    }
    expect(isReportGroupFor('Accounts MHUB', 'finance', 'MHUB')).toBe(true);
  });

  it('"Operation <CODE>" receives the Ticketing and Holidays desk posts of that branch', () => {
    for (const kind of ['ticketing', 'holidays'] as const) {
      for (const name of ['Operation BOM', 'Operation - BOM', 'operation bom']) {
        expect(isReportGroupFor(name, kind, 'BOM')).toBe(true);
      }
    }
  });

  it('never crosses branch, family, or the short-code substring trap', () => {
    expect(isReportGroupFor('Accounts BOM', 'accounts', 'AMD')).toBe(false);
    expect(isReportGroupFor('Accounts BOMX', 'accounts', 'BOM')).toBe(false);
    expect(isReportGroupFor('Accounts BOM', 'ticketing', 'BOM')).toBe(false);
    expect(isReportGroupFor('Accounts BOM', 'holidays', 'BOM')).toBe(false);
    expect(isReportGroupFor('Operation BOM', 'accounts', 'BOM')).toBe(false);
    expect(isReportGroupFor('Operation BOM', 'finance', 'BOM')).toBe(false);
    expect(isReportGroupFor('Operation BOM', 'hr', 'BOM')).toBe(false);
    expect(isReportGroupFor('Operation BOM', 'inb-ticketing', 'BOM/AMD')).toBe(false);
    expect(isReportGroupFor('Accounts BOM', 'tickets', '')).toBe(false);
  });

  it('the old names still route while the groups are renamed', () => {
    expect(isReportGroupFor('BOM - Branch Accounts', 'accounts', 'BOM')).toBe(true);
    expect(isReportGroupFor('MHUB - Finance Team', 'finance', 'MHUB')).toBe(true);
    expect(isReportGroupFor('BOM - Ticketing', 'ticketing', 'BOM')).toBe(true);
    expect(isReportGroupFor('BOM - Holidays', 'holidays', 'BOM')).toBe(true);
  });

  it('the Mongo pre-filter lets the new names through for every kind that uses them', () => {
    const passes = (kind: Parameters<typeof reportGroupNameHint>[0], name: string) => new RegExp(reportGroupNameHint(kind), 'i').test(name);
    expect(passes('accounts', 'Accounts BOM')).toBe(true);
    expect(passes('finance', 'Accounts BOM')).toBe(true);
    expect(passes('finance', 'MHUB - Finance Team')).toBe(true);
    expect(passes('hr', 'Accounts BOM')).toBe(true);
    expect(passes('hr', 'BOM - HR Team')).toBe(true);
    expect(passes('ticketing', 'Operation BOM')).toBe(true);
    expect(passes('holidays', 'Operation BOM')).toBe(true);
    expect(passes('inb-ticketing', 'INB Ticketing AMD/BOM')).toBe(true);
  });

  it('names the new group when there is none', () => {
    expect(reportGroupExpected('ticketing', 'AMD')).toBe('"Operation AMD"');
    expect(reportGroupExpected('holidays', 'AMD')).toBe('"Operation AMD"');
  });
});

// Approved invoices and deals split by desk: flights to Ticketing, everything else to Holidays.
describe('desk group routing', () => {
  it('matches "<CODE> - Ticketing" and "<CODE> - Holidays"', () => {
    expect(isReportGroupFor('BOM - Ticketing', 'ticketing', 'BOM')).toBe(true);
    expect(isReportGroupFor('AMD - Holidays', 'holidays', 'AMD')).toBe(true);
    expect(isReportGroupFor('bom  ticketing', 'ticketing', 'BOM')).toBe(true);
  });

  it('never crosses desk, branch, or family', () => {
    expect(isReportGroupFor('BOM - Ticketing', 'holidays', 'BOM')).toBe(false);
    expect(isReportGroupFor('BOM - Ticketing', 'ticketing', 'AMD')).toBe(false);
    expect(isReportGroupFor('BOM - Ticketing', 'accounts', 'BOM')).toBe(false);
    expect(isReportGroupFor('INB Ticketing AMD/BOM', 'ticketing', 'BOM')).toBe(false);
  });
});

// An inter-branch deal belongs to BOTH its branches, in the room they share. The pair is
// unordered: the group was named in whichever order its creator typed.
describe('INB pair group routing', () => {
  it('matches the pair group in either order', () => {
    expect(isReportGroupFor('INB Ticketing AMD/BOM', 'inb-ticketing', 'BOM/AMD')).toBe(true);
    expect(isReportGroupFor('INB Ticketing AMD/BOM', 'inb-ticketing', 'AMD/BOM')).toBe(true);
    expect(isReportGroupFor('INB Holidays DAR/FBM', 'inb-holidays', 'FBM/DAR')).toBe(true);
    expect(reportGroupKeys('inb-ticketing', 'BOM/AMD')).toEqual(['inbticketingbomamd', 'inbticketingamdbom']);
  });

  it('refuses a half-written or self-referencing pair rather than guessing', () => {
    expect(reportGroupKeys('inb-ticketing', 'BOM')).toEqual([]);
    expect(reportGroupKeys('inb-holidays', 'BOM/')).toEqual([]);
    expect(reportGroupKeys('inb-ticketing', 'BOM/BOM')).toEqual([]); // a branch cannot deal with itself
    expect(isReportGroupFor('INB Ticketing AMD/BOM', 'inb-ticketing', 'BOM')).toBe(false);
  });

  it('keeps a third branch out of a pair it is not in', () => {
    expect(isReportGroupFor('INB Ticketing AMD/BOM', 'inb-ticketing', 'BOM/NBO')).toBe(false);
    expect(isReportGroupFor('INB Ticketing AMD/BOM', 'inb-holidays', 'AMD/BOM')).toBe(false); // wrong desk
  });

  it('says which room it expected when there is none', () => {
    expect(reportGroupExpected('inb-holidays', 'BOM/NBO')).toBe('"INB Holidays BOM/NBO" (either order)');
    expect(reportGroupExpected('ticketing', 'DAR')).toBe('"Operation DAR"');
  });
});

describe('tickets — the one company-wide "Ticket Support" room (owner, 2026-10-12)', () => {
  it('matches the group however it is punctuated, whatever branch code is sent', () => {
    for (const name of ['Ticket Support', 'ticket-support', 'TICKET  SUPPORT', 'Tickets Support']) {
      expect(isReportGroupFor(name, 'tickets', '')).toBe(true);
      expect(isReportGroupFor(name, 'tickets', 'BOM')).toBe(true);
    }
  });
  it('never matches another room', () => {
    expect(isReportGroupFor('BOM - Ticketing', 'tickets', 'BOM')).toBe(false);
    expect(isReportGroupFor('Ticket Support Old', 'tickets', '')).toBe(false);
    expect(isReportGroupFor('Support', 'tickets', '')).toBe(false);
  });
  it('names the group it expected when there is none', () => {
    expect(reportGroupExpected('tickets', '')).toBe('"Ticket Support"');
    expect(reportGroupKey('tickets', 'AMD')).toBe('ticketsupport');
  });
});
