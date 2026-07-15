import { createHash, timingSafeEqual } from 'crypto';
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { config } from '../../config';
import { AppError, Unauthorized } from '../../common/errors';

// Service-to-service auth for the ERP/CRM → app alert ingest. This is deliberately NOT a user JWT:
// the emitting backends hold one long-lived shared secret (ALERTS_INGEST_TOKEN, set on both sides),
// presented as `Authorization: Bearer <token>` or `X-Service-Token`. Unset token = ingest disabled
// (503), so a fresh deployment can never be written to by accident.
const tokenFromReq = (req: Request): string => {
  const auth = req.headers.authorization ?? '';
  if (auth.startsWith('Bearer ')) return auth.slice('Bearer '.length).trim();
  const header = req.headers['x-service-token'];
  return (Array.isArray(header) ? header[0] : header ?? '').trim();
};

// Constant-time comparison; sha256 first so lengths always match.
const tokensMatch = (a: string, b: string): boolean =>
  timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());

export const requireServiceToken: RequestHandler = (req: Request, _res: Response, next: NextFunction) => {
  const expected = config.alerts.ingestToken;
  if (!expected) {
    next(new AppError(503, 'Alert ingest is not configured on this server', 'INGEST_DISABLED'));
    return;
  }
  const presented = tokenFromReq(req);
  if (!presented || !tokensMatch(presented, expected)) {
    next(Unauthorized('Invalid service token'));
    return;
  }
  next();
};
