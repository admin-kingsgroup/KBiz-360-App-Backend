import { Router, type Request, type Response } from 'express';
import { asyncHandler } from '../../common/asyncHandler';
import { AppError, NotFound, Unauthorized } from '../../common/errors';
import { config } from '../../config';
import { requireAuth } from '../middleware';
import { isAllowedErpCall } from './erpAllowList';

// Mounted at /api/erp. ERP approvals in the app (owner, 2026-10-07): "if a user has access to the
// ERP and the app, the ERP approvals show in the app — and the web page does not log out". The
// phone never talks to the ERP and never holds an ERP login. This router forwards a fixed set of
// approval calls to the ERP's app door with the shared secret (ERP_APP_SERVICE_TOKEN = the ERP's
// APP_SERVICE_TOKEN) and the SIGNED-IN user's id — taken only from the verified app JWT, never
// from the client. The ERP builds that person's Books identity and applies every approval rule.
export const erpRouter: Router = Router();
erpRouter.use(requireAuth);

const TIMEOUT_MS = 20_000;

// Is the link set up on this server? The app hides the ERP section when it is not.
erpRouter.get('/status', (_req: Request, res: Response) => {
  res.json({ configured: !!(config.erp.apiUrl && config.erp.appServiceToken) });
});

erpRouter.all('/*', asyncHandler(async (req: Request, res: Response) => {
  const { apiUrl, appServiceToken } = config.erp;
  if (!apiUrl || !appServiceToken) throw new AppError(503, 'ERP approvals are not set up on this server', 'ERP_NOT_CONFIGURED');
  if (!req.auth?.userId) throw Unauthorized();

  const rest = req.path.replace(/\/+$/, '');            // "/vouchers/approvals"
  const erpPath = `/api${rest}`;
  if (!isAllowedErpCall(req.method, erpPath)) throw NotFound(`No ERP route for ${req.method} ${rest}`);
  const qIndex = req.originalUrl.indexOf('?');
  const query = qIndex >= 0 ? req.originalUrl.slice(qIndex) : '';
  const hasBody = req.method === 'POST' || req.method === 'PUT';

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  const started = Date.now();
  let upstream: globalThis.Response;
  try {
    upstream = await fetch(`${apiUrl}${erpPath}${query}`, {
      method: req.method,
      // ONLY these headers: never the phone's Authorization, never a client-sent X-Act-As.
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-App-Service-Token': appServiceToken,
        'X-Act-As': req.auth.userId,
      },
      body: hasBody ? JSON.stringify(req.body ?? {}) : undefined,
      signal: ctrl.signal,
    });
  } catch (e) {
    const timedOut = (e as { name?: string })?.name === 'AbortError';
    console.warn(`[erp] ${req.method} ${erpPath} user=${req.auth.userId} ${timedOut ? 'timeout' : 'unreachable'} ${Date.now() - started}ms`);
    throw timedOut
      ? new AppError(504, 'The ERP took too long to answer', 'ERP_TIMEOUT')
      : new AppError(502, 'Could not reach the ERP', 'ERP_UNREACHABLE');
  } finally {
    clearTimeout(timer);
  }
  console.log(`[erp] ${req.method} ${erpPath} user=${req.auth.userId} ${upstream.status} ${Date.now() - started}ms`);

  const text = await upstream.text();
  let body: { success?: boolean; message?: string; code?: string } | null = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = null; }
  if (!body && upstream.status !== 204) throw new AppError(502, 'The ERP sent an unreadable answer', 'ERP_BAD_GATEWAY');

  if (upstream.ok) { res.status(upstream.status).json(body); return; }
  const message = body?.message || `The ERP refused (${upstream.status})`;
  // An ERP 401 means the link itself was refused (secret, or the person's ERP login is off). It must
  // NOT reach the phone as a 401: the app reads 401 as "your app session expired" and signs out.
  if (upstream.status === 401) throw new AppError(502, message, 'ERP_AUTH');
  if (upstream.status >= 500) throw new AppError(502, message, 'ERP_ERROR');
  // 400/403/404/409/422 carry the ERP's own reason ("awaiting Check", "outside your access"…).
  throw new AppError(upstream.status, message, body?.code || 'ERP_REFUSED');
}));
