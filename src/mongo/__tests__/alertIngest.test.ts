import {
  ALERT_CHANNELS,
  ALERT_GRANT_IDS,
  branchWideGrants,
  canonicalBranchCode,
  channelForModuleBranch,
  effectiveGrants,
  isBranchWideGrant,
  visibleChannelIds,
} from '../alerts/alertChannels';
import { contactSchema, e164 } from '../alerts/alertContact';
import { attendanceBranchCode } from '../attendance/attendanceBranch';

// Pure unit tests — no DB. The live ingest path is exercised by the smoke/e2e flow.

describe('alert channel registry', () => {
  it('registers the legacy pair and the five Alerts groups (HR · CRM · ERP · CRM Reports · ERP Reports)', () => {
    const six = ['bom', 'amd', 'nbo', 'dar', 'fbm', 'mhub'];
    const five = ['bom', 'amd', 'nbo', 'dar', 'fbm'];
    expect(ALERT_CHANNELS.map((c) => c.id)).toEqual([
      'tk_fin_bom', 'tk_fin_amd', 'tk_crm_bom', 'tk_crm_amd',
      ...six.map((b) => `tk_hr_${b}`),
      ...five.map((b) => `tk_lead_${b}`),
      ...six.map((b) => `tk_erp_${b}`),
      ...five.map((b) => `tk_crmrep_${b}`),
      ...six.map((b) => `tk_erprep_${b}`),
    ]);
    expect(ALERT_CHANNELS.find((c) => c.id === 'tk_hr_mhub')).toMatchObject({ name: 'HR - MHUB', grant: 'MHUB-attendance' });
    expect(ALERT_CHANNELS.find((c) => c.id === 'tk_lead_bom')).toMatchObject({ name: 'CRM - BOM', grant: 'BOM-leads' });
    expect(ALERT_CHANNELS.find((c) => c.id === 'tk_erp_nbo')).toMatchObject({ name: 'ERP - NBO', grant: 'NBO-erp' });
    expect(ALERT_CHANNELS.find((c) => c.id === 'tk_crmrep_dar')).toMatchObject({ name: 'CRM Reports - DAR', grant: 'DAR-crm-reports' });
    expect(ALERT_CHANNELS.find((c) => c.id === 'tk_erprep_fbm')).toMatchObject({ name: 'ERP Reports - FBM', grant: 'FBM-erp-reports' });
    // The legacy grant-only pair no longer shares the "CRM - BOM" name with the new CRM group.
    expect(ALERT_CHANNELS.find((c) => c.id === 'tk_crm_bom')?.name).toBe('CRM Payments - BOM');
    expect(new Set(ALERT_CHANNELS.map((c) => c.name)).size).toBe(ALERT_CHANNELS.length);
    expect(new Set(ALERT_GRANT_IDS).size).toBe(ALERT_GRANT_IDS.length);
  });

  it('ingest modules resolve to their group, per branch; the hub has no CRM channels', () => {
    for (const br of ['BOM', 'AMD', 'NBO', 'DAR', 'FBM', 'MHUB']) {
      expect(channelForModuleBranch('erp', br)?.id).toBe(`tk_erp_${br.toLowerCase()}`);
      expect(channelForModuleBranch('erp-reports', br)?.id).toBe(`tk_erprep_${br.toLowerCase()}`);
      expect(channelForModuleBranch('attendance', br)?.id).toBe(`tk_hr_${br.toLowerCase()}`);
    }
    for (const br of ['BOM', 'AMD', 'NBO', 'DAR', 'FBM']) {
      expect(channelForModuleBranch('leads', br)?.id).toBe(`tk_lead_${br.toLowerCase()}`);
      expect(channelForModuleBranch('crm-reports', br)?.id).toBe(`tk_crmrep_${br.toLowerCase()}`);
    }
    expect(channelForModuleBranch('leads', 'MHUB')).toBeNull();
    expect(channelForModuleBranch('crm-reports', 'MHUB')).toBeNull();
  });

  it("the ERP's wave-29 Africa codes (HNBO/HDAR/HFBM) land in the NBO/DAR/FBM channels", () => {
    expect(canonicalBranchCode('hnbo')).toBe('NBO');
    expect(canonicalBranchCode(' HDAR ')).toBe('DAR');
    expect(canonicalBranchCode('HFBM')).toBe('FBM');
    expect(canonicalBranchCode('BOM')).toBe('BOM');
    expect(canonicalBranchCode(null)).toBe('');
    expect(channelForModuleBranch('erp', 'HNBO')?.id).toBe('tk_erp_nbo');
    expect(channelForModuleBranch('leads', 'HFBM')?.id).toBe('tk_lead_fbm');
    expect(channelForModuleBranch('attendance', 'HDAR')?.id).toBe('tk_hr_dar');
    // A Nairobi user's branch row now says HNBO — they must still get Nairobi's CRM channels.
    expect(branchWideGrants(['HNBO'])).toEqual(['NBO-leads', 'NBO-crm-reports']);
  });

  it('only CRM and CRM Reports are branch-wide — HR / ERP / ERP Reports stay grant-only', () => {
    const wide = [...new Set(ALERT_CHANNELS.filter((c) => c.branchWide).map((c) => c.module))].sort();
    expect(wide).toEqual(['crm-reports', 'leads']);
  });

  it('branch membership grants that branch’s CRM + CRM Reports; company-wide roles get all', () => {
    expect(branchWideGrants(['BOM'])).toEqual(['BOM-leads', 'BOM-crm-reports']);
    expect(branchWideGrants(['bom', 'NBO'])).toEqual(['BOM-leads', 'NBO-leads', 'BOM-crm-reports', 'NBO-crm-reports']);
    expect(branchWideGrants(['MHUB'])).toEqual([]);
    expect(branchWideGrants([])).toEqual([]);
    expect(branchWideGrants(null)).toHaveLength(10);
    // A BOM salesperson sees BOM's CRM + CRM Reports and nothing of HR / ERP / ERP Reports.
    expect(visibleChannelIds(false, branchWideGrants(['BOM']))).toEqual(['tk_lead_bom', 'tk_crmrep_bom']);
    // …which only a grant opens.
    expect(visibleChannelIds(false, ['BOM-attendance', 'BOM-erp', 'BOM-erp-reports'])).toEqual(['tk_hr_bom', 'tk_erp_bom', 'tk_erprep_bom']);
  });

  it('maps (module, branch) to the right channel, with finance → accounts aliasing', () => {
    expect(channelForModuleBranch('finance', 'BOM')?.id).toBe('tk_fin_bom');
    expect(channelForModuleBranch('accounts', 'AMD')?.id).toBe('tk_fin_amd');
    expect(channelForModuleBranch('crm', 'bom')?.id).toBe('tk_crm_bom'); // case-insensitive branch
    expect(channelForModuleBranch('crm', 'AMD')?.id).toBe('tk_crm_amd');
    expect(channelForModuleBranch('finance', 'NBO')).toBeNull(); // Finance stays BOM/AMD → emitters must skip
  });

  it('the retired report families resolve to NOTHING — they live in the Finance group chats now', () => {
    // Clients Receivables / Supplier Payables / Bank & Cash were deleted 2026-08-19. An emitter
    // still aiming here must land nowhere (and the ingest's zod enum rejects the module outright),
    // never in some neighbouring channel.
    for (const mod of ['receivables', 'payables', 'bankcash', 'acct', 'hr', 'sales', 'sales-invoice', 'bookings']) {
      for (const br of ['BOM', 'AMD', 'NBO', 'DAR', 'FBM']) expect(channelForModuleBranch(mod, br)).toBeNull();
    }
    expect(ALERT_CHANNELS.some((c) => /^tk_(ar|ap|bc|acc|att|si|bkg)_/.test(c.id))).toBe(false);
    expect(ALERT_GRANT_IDS.some((g) => /-(receivables|payables|bankcash|acct|hr|sales|bookings)$/.test(g))).toBe(false);
  });

  it("the retired 'acct' feed resolves to nothing — it posts into <BR> - Branch Accounts now", () => {
    for (const br of ['BOM', 'AMD', 'NBO', 'DAR', 'FBM']) expect(channelForModuleBranch('acct', br)).toBeNull();
    expect(ALERT_CHANNELS.some((c) => c.id.startsWith('tk_acc_'))).toBe(false);
    expect(ALERT_GRANT_IDS.some((g) => g.endsWith('-acct'))).toBe(false);
    expect(channelForModuleBranch('accounts', 'BOM')?.id).toBe('tk_fin_bom'); // legacy Finance untouched
  });

  it('attendance has no channels at all — the day-close report goes to the branch group chats', () => {
    expect(ALERT_CHANNELS.some((c) => c.id.startsWith('tk_att_'))).toBe(false);
    expect(ALERT_GRANT_IDS.some((g) => g.endsWith('-hr'))).toBe(false);
  });

  it('resolves a puncher\'s branch via code → alias → city (legacy MUM staff must count as BOM)', () => {
    expect(attendanceBranchCode({ code: 'BOM' })).toBe('BOM');
    expect(attendanceBranchCode({ code: 'MUM' })).toBe('BOM'); // legacy alias
    expect(attendanceBranchCode({ code: '', city: 'Ahmedabad' })).toBe('AMD'); // city fallback
    // Every branch reports now — the Africa branches are no longer dropped for want of a channel.
    expect(attendanceBranchCode({ code: 'NBO', city: 'Nairobi' })).toBe('NBO');
    expect(attendanceBranchCode({ code: 'MHUB', city: 'Mumbai' })).toBe('MHUB');
    expect(attendanceBranchCode(null)).toBe('');
  });

  it('supers see every channel; non-supers exactly their granted channels', () => {
    expect(visibleChannelIds(true, [])).toEqual(ALERT_CHANNELS.map((c) => c.id));
    expect(visibleChannelIds(false, [])).toEqual([]);
    expect(visibleChannelIds(false, ['BOM-accounts'])).toEqual(['tk_fin_bom']);
    expect(visibleChannelIds(false, ['BOM-accounts', 'BOM-crm', 'AMD-hr'])).toEqual(['tk_fin_bom', 'tk_crm_bom']); // -hr grants no longer resolve
    expect(visibleChannelIds(false, ['NBO-sales', 'FBM-sales'])).toEqual([]); // sales grants no longer resolve
    expect(visibleChannelIds(false, ['NBO-accounts', 'bogus'])).toEqual([]); // unknown grants grant nothing
  });
});

describe('attachmentFilename', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { attachmentFilename } = require('../alerts/alertsIngest.router');

  it('always ends in .pdf, surviving the storage layer safeName slice(0,120)', () => {
    // The attack: filler + '.html' sized so append-then-truncate would have left the
    // stored key ending '.html' (served as text/html by express.static = stored XSS).
    for (const attack of ['a'.repeat(115) + '.html', 'a'.repeat(90) + '.html', 'x.html']) {
      const out = attachmentFilename(attack);
      expect(out.endsWith('.pdf')).toBe(true);
      expect(out.endsWith('.html')).toBe(false);
      expect(out.length).toBeLessThanOrEqual(104); // ≤100 base + '.pdf' → safeName never truncates
    }
  });

  it('sanitizes, dedupes .pdf, and falls back on empty names', () => {
    expect(attachmentFilename('Invoice-BOM-0726-SF01127.pdf')).toBe('Invoice-BOM-0726-SF01127.pdf');
    expect(attachmentFilename('inv oice/№1.PDF')).toBe('inv_oice__1.pdf');
    expect(attachmentFilename('...')).toBe('....pdf'); // dots are legal filename chars
    expect(attachmentFilename('')).toBe('document.pdf');
  });
});

describe('ingestRateLimit', () => {
  it('allows a burst up to capacity then 429s', () => {
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { ingestRateLimit } = require('../alerts/alertsIngest.router');
      let limited = 0;
      for (let i = 0; i < 121; i += 1) {
        const next = jest.fn();
        ingestRateLimit({} as never, {} as never, next);
        if (next.mock.calls[0][0]?.status === 429) limited += 1;
      }
      expect(limited).toBe(1); // exactly the 121st call in the same instant is limited
    });
  });
});

describe('requireServiceToken', () => {
  // serviceAuth reads config at import time — isolate modules per case so env changes apply.
  const withToken = (
    envToken: string | undefined,
    run: (mw: (req: unknown, res: unknown, next: jest.Mock) => void) => void,
  ): void => {
    const orig = process.env.ALERTS_INGEST_TOKEN;
    if (envToken === undefined) delete process.env.ALERTS_INGEST_TOKEN;
    else process.env.ALERTS_INGEST_TOKEN = envToken;
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { requireServiceToken } = require('../alerts/serviceAuth');
      run(requireServiceToken);
    });
    if (orig === undefined) delete process.env.ALERTS_INGEST_TOKEN;
    else process.env.ALERTS_INGEST_TOKEN = orig;
  };

  it('503 when ALERTS_INGEST_TOKEN is unset (ingest disabled by default)', () => {
    withToken(undefined, (mw) => {
      const next = jest.fn();
      mw({ headers: {} }, {}, next);
      expect(next.mock.calls[0][0]?.status).toBe(503);
    });
  });

  it('401 on missing or wrong token', () => {
    withToken('right-token', (mw) => {
      const missing = jest.fn();
      mw({ headers: {} }, {}, missing);
      expect(missing.mock.calls[0][0]?.status).toBe(401);
      const wrong = jest.fn();
      mw({ headers: { authorization: 'Bearer wrong-token' } }, {}, wrong);
      expect(wrong.mock.calls[0][0]?.status).toBe(401);
    });
  });

  it('passes with the right token via Bearer or X-Service-Token', () => {
    withToken('right-token', (mw) => {
      const bearer = jest.fn();
      mw({ headers: { authorization: 'Bearer right-token' } }, {}, bearer);
      expect(bearer).toHaveBeenCalledWith();
      const header = jest.fn();
      mw({ headers: { 'x-service-token': 'right-token' } }, {}, header);
      expect(header).toHaveBeenCalledWith();
    });
  });
});

describe('branch-wide channels are for their own branch only (owner, 2026-09-27)', () => {
  it('CRM and CRM Reports grants are branch-wide; HR / ERP / ERP Reports are not', () => {
    expect(isBranchWideGrant('BOM-leads')).toBe(true);
    expect(isBranchWideGrant('NBO-crm-reports')).toBe(true);
    expect(isBranchWideGrant('BOM-erp')).toBe(false);
    expect(isBranchWideGrant('BOM-attendance')).toBe(false);
  });

  it("a stored grant can never show another branch's CRM alerts", () => {
    // An AMD user who somehow holds BOM-leads / BOM-crm-reports in storage (plus a real ERP grant).
    const amd = effectiveGrants(['BOM-leads', 'BOM-crm-reports', 'BOM-erp'], ['AMD']);
    expect(amd.sort()).toEqual(['AMD-crm-reports', 'AMD-leads', 'BOM-erp']);
    expect(visibleChannelIds(false, amd)).not.toContain('tk_lead_bom');
    expect(visibleChannelIds(false, amd)).toContain('tk_lead_amd');
    // A BOM user sees BOM's CRM alerts only.
    expect(visibleChannelIds(false, effectiveGrants([], ['BOM']))).toEqual(['tk_lead_bom', 'tk_crmrep_bom']);
    // A user in no branch sees no CRM alerts at all.
    expect(effectiveGrants(['BOM-leads'], [])).toEqual([]);
    // Company-wide roles (branchCodes null) still see every branch's.
    expect(effectiveGrants([], null)).toHaveLength(10);
  });
});

describe('alert contact (the converted lead\'s client → WhatsApp / Call)', () => {
  it('normalises to E.164', () => {
    expect(e164('+91 98765-43210')).toBe('+919876543210');
    expect(e164('0091 (98765) 43210')).toBe('+919876543210');
    expect(e164('+254700000000')).toBe('+254700000000');
  });

  it('refuses numbers that are not international', () => {
    expect(e164('9876543210')).toBeNull(); // no country code — could be anywhere
    expect(e164('+0123456789')).toBeNull();
    expect(e164('+12345')).toBeNull();
    expect(e164('+91 98765 43210 ext 5')).toBeNull();
    expect(e164('')).toBeNull();
    expect(e164(null)).toBeNull();
  });

  it('ingest schema stores the normalised phone and fails loudly on a bad one', () => {
    expect(contactSchema.parse({ name: ' Pradip Shimpi ', phone: '+91 98765 43210' })).toEqual({ name: 'Pradip Shimpi', phone: '+919876543210' });
    expect(contactSchema.parse({ phone: '+254700000000' })).toEqual({ phone: '+254700000000' });
    expect(contactSchema.safeParse({ phone: '9876543210' }).success).toBe(false);
    expect(contactSchema.safeParse({ name: 'No phone' }).success).toBe(false);
  });
});
