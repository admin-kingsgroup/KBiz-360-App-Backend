import {
  ALERT_CHANNELS,
  ALERT_GRANT_IDS,
  channelForBranchCode,
  channelForModuleBranch,
  visibleChannelIds,
} from '../alerts/alertChannels';

// Pure unit tests — no DB. The live ingest path is exercised by the smoke/e2e flow.

describe('alert channel registry', () => {
  it('registers the four external channels next to attendance', () => {
    expect(ALERT_CHANNELS.map((c) => c.id)).toEqual([
      'tk_att_bom', 'tk_att_amd', 'tk_fin_bom', 'tk_fin_amd', 'tk_crm_bom', 'tk_crm_amd',
    ]);
    expect(ALERT_GRANT_IDS).toEqual(
      expect.arrayContaining(['BOM-accounts', 'AMD-accounts', 'BOM-crm', 'AMD-crm']),
    );
  });

  it('maps (module, branch) to the right channel, with finance → accounts aliasing', () => {
    expect(channelForModuleBranch('finance', 'BOM')?.id).toBe('tk_fin_bom');
    expect(channelForModuleBranch('accounts', 'AMD')?.id).toBe('tk_fin_amd');
    expect(channelForModuleBranch('crm', 'bom')?.id).toBe('tk_crm_bom'); // case-insensitive branch
    expect(channelForModuleBranch('crm', 'AMD')?.id).toBe('tk_crm_amd');
    expect(channelForModuleBranch('finance', 'NBO')).toBeNull(); // no channel → emitters must skip
  });

  it('keeps channelForBranchCode pinned to ATTENDANCE channels (order-independent)', () => {
    expect(channelForBranchCode('BOM')?.id).toBe('tk_att_bom');
    expect(channelForBranchCode('AMD')?.id).toBe('tk_att_amd');
  });

  it('supers see every channel; non-supers none (current policy)', () => {
    expect(visibleChannelIds(true, [])).toEqual(ALERT_CHANNELS.map((c) => c.id));
    expect(visibleChannelIds(false, ['BOM-accounts'])).toEqual([]);
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
