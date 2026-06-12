import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { Unauthorized, Forbidden } from '../../common/errors';
import { accessService } from './access.service';

// Gate that requires the authenticated user to be able to MANAGE (canManage = Super Admin OR Director).
// Mirrors deriveAccess().canManage exactly (via AccessService). Use after requireAuth.
export const requireManage: RequestHandler = (req: Request, _res: Response, next: NextFunction) => {
  void (async () => {
    try {
      if (!req.auth) throw Unauthorized();
      const access = await accessService.accessForUserId(req.auth.userId);
      if (!access) throw Unauthorized('Session user not found');
      if (!access.canManage) throw Forbidden('Requires manage permission (Super Admin or Director)');
      next();
    } catch (err) {
      next(err);
    }
  })();
};

// Gate that requires SUPER_ADMIN (e.g. audit log — a Super-only permission). Use after requireAuth.
export const requireSuper: RequestHandler = (req: Request, _res: Response, next: NextFunction) => {
  void (async () => {
    try {
      if (!req.auth) throw Unauthorized();
      const access = await accessService.accessForUserId(req.auth.userId);
      if (!access) throw Unauthorized('Session user not found');
      if (!access.isSuper) throw Forbidden('Requires Super Admin');
      next();
    } catch (err) {
      next(err);
    }
  })();
};
