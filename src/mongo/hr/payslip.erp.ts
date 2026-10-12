import { AppError, BadRequest } from '../../common/errors';
import { config } from '../../config';

// The payslip in the app (owner, 2026-10-12): "show the SAME payslip as the ERP — and until the
// salary is released don't share that month's payslip". Released = paid in full; the ERP decides
// it. This backend never prices a payslip any more: it asks the ERP's app-hr door, server to
// server, for the signed-in person's released months and for a 15-minute signed link to Books' own
// payslip page (opened in the app's WebView). Same link as the approvals forwarder
// (erp/erp.router.ts): the shared secret ERP_APP_SERVICE_TOKEN and the person from the verified
// app JWT — never from the client.

const TIMEOUT_MS = 20_000;

export const PAYSLIP_MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

export interface PayslipMonth {
  month: string;           // 'YYYY-MM'
  label: string;           // 'September 2026'
  branch: string;
  net: number;
  currency: string;
  vno: string;             // the salary voucher
  paidOn: string;          // 'YYYY-MM-DD' | ''
  source: 'paid' | 'history' | 'run';
}

export interface PayslipLink {
  url: string;
  expiresAt: string;       // ISO
  month: string;
  label: string;
}

type ErpBody = { success?: boolean; message?: string; code?: string; data?: unknown } | null;

/** GET one app-hr path on the ERP as `userId`; returns the ERP's `data`. Errors are AppErrors the phone can show. */
async function erpGet(userId: string, path: string): Promise<unknown> {
  const { apiUrl, appServiceToken } = config.erp;
  if (!apiUrl || !appServiceToken) throw new AppError(503, 'Payslips are not available right now', 'ERP_NOT_CONFIGURED');

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  const started = Date.now();
  let upstream: globalThis.Response;
  try {
    upstream = await fetch(`${apiUrl}${path}`, {
      method: 'GET',
      // ONLY these headers: never the phone's Authorization, never a client-sent X-Act-As.
      headers: {
        Accept: 'application/json',
        'X-App-Service-Token': appServiceToken,
        'X-Act-As': userId,
      },
      signal: ctrl.signal,
    });
  } catch (e) {
    const timedOut = (e as { name?: string })?.name === 'AbortError';
    console.warn(`[payslip] GET ${path} user=${userId} ${timedOut ? 'timeout' : 'unreachable'} ${Date.now() - started}ms`);
    throw timedOut
      ? new AppError(504, 'The ERP took too long to answer', 'ERP_TIMEOUT')
      : new AppError(502, 'Could not reach the ERP', 'ERP_UNREACHABLE');
  } finally {
    clearTimeout(timer);
  }
  console.log(`[payslip] GET ${path} user=${userId} ${upstream.status} ${Date.now() - started}ms`);

  const text = await upstream.text();
  let body: ErpBody = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = null; }
  if (!body) throw new AppError(502, 'The ERP sent an unreadable answer', 'ERP_BAD_GATEWAY');

  if (upstream.ok) return body.data;
  const message = body.message || `The ERP refused (${upstream.status})`;
  // An ERP 401 means the link itself was refused (secret, or the person's login is off). It must
  // NOT reach the phone as a 401: the app reads 401 as "your app session expired" and signs out.
  if (upstream.status === 401) throw new AppError(502, message, 'ERP_AUTH');
  if (upstream.status >= 500) throw new AppError(502, message, 'ERP_ERROR');
  // 400/403/404 carry the ERP's own reason ("shows here once that salary is paid", "not on the register").
  throw new AppError(upstream.status, message, body.code || 'ERP_REFUSED');
}

const str = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v));

/** Only the contract's fields reach the phone. */
export function toPayslipMonth(raw: unknown): PayslipMonth | null {
  const r = (raw ?? {}) as Record<string, unknown>;
  const month = str(r.month);
  if (!PAYSLIP_MONTH_RE.test(month)) return null;
  const source = r.source === 'history' || r.source === 'run' ? r.source : 'paid';
  return {
    month,
    label: str(r.label) || month,
    branch: str(r.branch),
    net: Number(r.net) || 0,
    currency: str(r.currency),
    vno: str(r.vno),
    paidOn: str(r.paidOn),
    source,
  };
}

export const payslipErp = {
  /** GET /hr/payslips — the caller's RELEASED months (paid in full), newest first, as the ERP lists them. */
  async months(userId: string): Promise<{ months: PayslipMonth[] }> {
    const data = (await erpGet(userId, '/api/app-hr/payslips')) as { months?: unknown } | undefined;
    const list = Array.isArray(data?.months) ? data.months : [];
    return { months: list.map(toPayslipMonth).filter((m): m is PayslipMonth => m !== null) };
  },

  /** GET /hr/payslips/:month/link — a 15-minute signed link to Books' payslip page (403 until released). */
  async link(userId: string, month: string): Promise<PayslipLink> {
    if (!PAYSLIP_MONTH_RE.test(month)) throw BadRequest('Pick a month (YYYY-MM)');
    const data = (await erpGet(userId, `/api/app-hr/payslips/${month}/link`)) as Partial<PayslipLink> | undefined;
    if (!data || typeof data.url !== 'string' || !/^https?:\/\//.test(data.url)) {
      throw new AppError(502, 'The ERP sent no payslip link', 'ERP_BAD_GATEWAY');
    }
    return { url: data.url, expiresAt: str(data.expiresAt), month: str(data.month) || month, label: str(data.label) || month };
  },
};
