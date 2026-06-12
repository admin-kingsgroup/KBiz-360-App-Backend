import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { Unauthorized, Forbidden } from '../common/errors';
import { accessService } from './access';

// JWT verification is transport-only — reuse the existing requireAuth (no Prisma dependency).
export { requireAuth } from '../modules/auth/auth.middleware';

// canManage = super_admin OR company_manager (level <= 2).
export const requireManage: RequestHandler = (req: Request, _res: Response, next: NextFunction) => {
  void (async () => {
    try {
      if (!req.auth) throw Unauthorized();
      const access = await accessService.accessForUserId(req.auth.userId);
      if (!access) throw Unauthorized('Session user not found');
      if (!access.canManage) throw Forbidden('Requires super_admin or company_manager');
      next();
    } catch (err) {
      next(err);
    }
  })();
};

// isSuper = super_admin (level 1 / '*').
export const requireSuper: RequestHandler = (req: Request, _res: Response, next: NextFunction) => {
  void (async () => {
    try {
      if (!req.auth) throw Unauthorized();
      const access = await accessService.accessForUserId(req.auth.userId);
      if (!access) throw Unauthorized('Session user not found');
      if (!access.isSuper) throw Forbidden('Requires super_admin');
      next();
    } catch (err) {
      next(err);
    }
  })();
};
