import {
  ALERT_CHANNELS,
  ALERT_GRANT_IDS,
  channelForModuleBranch,
  visibleChannelIds,
} from '../alerts/alertChannels';
import { attendanceBranchCode } from '../attendance/attendanceBranch';

// Pure unit tests — no DB. The live ingest path is exercised by the smoke/e2e flow.

describe('alert channel registry', () => {
  it('registers the external channels next to attendance', () => {
    expect(ALERT_CHANNELS.map((c) => c.id)).toEqual([
      'tk_fin_bom', 'tk_fin_amd', 'tk_crm_bom', 'tk_crm_amd',
      'tk_si_bom', 'tk_si_amd', 'tk_si_nbo', 'tk_si_dar', 'tk_si_fbm',
      'tk_bkg_bom', 'tk_bkg_amd', 'tk_bkg_nbo', 'tk_bkg_dar', 'tk_bkg_fbm',
      'tk_acc_bom', 'tk_acc_amd', 'tk_acc_nbo', 'tk_acc_dar', 'tk_acc_fbm',
    ]);
    expect(ALERT_GRANT_IDS).toEqual(
      expect.arrayContaining([
        'BOM-accounts', 'AMD-accounts', 'BOM-crm', 'AMD-crm',
        'BOM-sales', 'AMD-sales', 'NBO-sales', 'DAR-sales', 'FBM-sales',
        'BOM-bookings', 'NBO-bookings', 'FBM-bookings',
        'BOM-acct', 'DAR-acct', 'FBM-acct',
      ]),
    );
  });

  it('maps (module, branch) to the right channel, with finance → accounts aliasing', () => {
    expect(channelForModuleBranch('finance', 'BOM')?.id).toBe('tk_fin_bom');
    expect(channelForModuleBranch('accounts', 'AMD')?.id).toBe('tk_fin_amd');
    expect(channelForModuleBranch('crm', 'bom')?.id).toBe('tk_crm_bom'); // case-insensitive branch
    expect(channelForModuleBranch('crm', 'AMD')?.id).toBe('tk_crm_amd');
    expect(channelForModuleBranch('finance', 'NBO')).toBeNull(); // Finance stays BOM/AMD → emitters must skip
  });

  it('maps sales to the per-branch Sales Invoice channels (all 5 branches)', () => {
    expect(channelForModuleBranch('sales', 'BOM')?.id).toBe('tk_si_bom');
    expect(channelForModuleBranch('sales', 'nbo')?.id).toBe('tk_si_nbo'); // case-insensitive branch
    expect(channelForModuleBranch('sales-invoice', 'FBM')?.id).toBe('tk_si_fbm'); // ERP vocabulary alias
    expect(channelForModuleBranch('sales', 'DAR')?.grant).toBe('DAR-sales');
    expect(channelForModuleBranch('sales', 'TKHO')).toBeNull(); // no channel → emitters must skip
  });

  it('the retired report families resolve to NOTHING — they live in the Finance group chats now', () => {
    // Clients Receivables / Supplier Payables / Bank & Cash were deleted 2026-08-19. An emitter
    // still aiming here must land nowhere (and the ingest's zod enum rejects the module outright),
    // never in some neighbouring channel.
    for (const mod of ['receivables', 'payables', 'bankcash']) {
      for (const br of ['BOM', 'AMD', 'NBO', 'DAR', 'FBM']) expect(channelForModuleBranch(mod, br)).toBeNull();
    }
    expect(ALERT_CHANNELS.some((c) => /^tk_(ar|ap|bc)_/.test(c.id))).toBe(false);
    expect(ALERT_GRANT_IDS.some((g) => /-(receivables|payables|bankcash)$/.test(g))).toBe(false);
  });

  it('maps bookings to the SO/PO/GP / INB channels (all 5 branches)', () => {
    expect(channelForModuleBranch('bookings', 'BOM')?.id).toBe('tk_bkg_bom');
    expect(channelForModuleBranch('bookings', 'nbo')?.id).toBe('tk_bkg_nbo');
    expect(channelForModuleBranch('bookings', 'FBM')?.grant).toBe('FBM-bookings');
    expect(channelForModuleBranch('bookings', 'TKHO')).toBeNull();
  });

  it("maps acct to the Accounts channels, distinct from the legacy 'accounts' Finance family", () => {
    expect(channelForModuleBranch('acct', 'BOM')?.id).toBe('tk_acc_bom');
    expect(channelForModuleBranch('acct', 'dar')?.id).toBe('tk_acc_dar');
    expect(channelForModuleBranch('acct', 'NBO')?.grant).toBe('NBO-acct');
    expect(channelForModuleBranch('accounts', 'BOM')?.id).toBe('tk_fin_bom'); // Finance untouched
    expect(channelForModuleBranch('acct', 'TKHO')).toBeNull();
  });

  it('attendance has no channels at all — the day-close report goes to the branch group chats', () => {
    expect(ALERT_CHANNELS.some((c) => c.id.startsWith('tk_att_'))).toBe(false);
    expect(ALERT_GRANT_IDS.some((g) => g.endsWith('-hr'))).toBe(false);
  });

  it('resolves a puncher\'s branch via code → alias → city (BOMMB staff must count as BOM)', () => {
    expect(attendanceBranchCode({ code: 'BOM' })).toBe('BOM');
    expect(attendanceBranchCode({ code: 'BOMMB', city: 'Mumbai' })).toBe('BOM'); // alias
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
    expect(visibleChannelIds(false, ['NBO-sales', 'FBM-sales'])).toEqual(['tk_si_nbo', 'tk_si_fbm']);
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
