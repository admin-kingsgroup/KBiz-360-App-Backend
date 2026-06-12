import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { Unauthorized } from '../../common/errors';
import { verifyAccess } from './jwt';

// Verifies the Bearer access token and attaches req.auth. Use on every protected route.
export const requireAuth: RequestHandler = (req: Request, _res: Response, next: NextFunction) => {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    next(Unauthorized('Missing bearer token'));
    return;
  }
  try {
    const claims = verifyAccess(header.slice('Bearer '.length));
    if (claims.type !== 'access') throw new Error('wrong token type');
    req.auth = { userId: claims.sub, role: claims.role };
    next();
  } catch {
    next(Unauthorized('Invalid or expired token'));
  }
};
