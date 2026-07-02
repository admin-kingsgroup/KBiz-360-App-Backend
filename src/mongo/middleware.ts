import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { Unauthorized, Forbidden } from '../common/errors';
import { accessService } from './access';
import { requireAuth as baseRequireAuth } from '../modules/auth/auth.middleware';
import { appAccess } from './appAccess';
import { crmRepo } from './crm.repo';

// requireAuth = JWT verification + the APP-ACCESS gates. A user whose access was disabled is
// rejected on their next request (their refresh then fails and login is blocked → they're logged out).
// Two independent switches are honoured: the mobile super-admin's own toggle (kb360_app.app_access)
// and the ERP-managed App Access toggle on the shared CRM user (access.app).
export const requireAuth: RequestHandler = (req: Request, res: Response, next: NextFunction) => {
  baseRequireAuth(req, res, (err?: unknown) => {
    if (err) { next(err); return; }
    void (async () => {
      try {
        if (req.auth) {
          if (await appAccess.isDisabled(req.auth.userId)) {
            next(Unauthorized('Your access has been disabled'));
            return;
          }
          // Deny-by-default allow-list (ERP-managed): only access.app === true may use the app.
          const user = await crmRepo.getUserById(req.auth.userId);
          if (!user || user.access?.app !== true) {
            next(Unauthorized('You no longer have access to this app.'));
            return;
          }
        }
        next();
      } catch (e) {
        next(e);
      }
    })();
  });
};

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
