import { Router, type Request } from 'express';
import { asyncHandler } from '../../common/asyncHandler';
import { Unauthorized } from '../../common/errors';
import { requireAuth } from '../auth/auth.middleware';
import { accessService } from '../access/access.service';
import { businessesService } from './businesses.service';
import type { AccessControl } from '../../domain/types';

// Org/read routes. All require auth; visibility is enforced by makeAccessFilters (via AccessService).
export const businessRouter: Router = Router();

async function getAccess(req: Request): Promise<AccessControl> {
  if (!req.auth) throw Unauthorized();
  const access = await accessService.accessForUserId(req.auth.userId);
  if (!access) throw Unauthorized('Session user not found');
  return access;
}

businessRouter.get(
  '/businesses',
  requireAuth,
  asyncHandler(async (req, res) => {
    res.json(await businessesService.listBusinesses(await getAccess(req)));
  }),
);

businessRouter.get(
  '/businesses/:id',
  requireAuth,
  asyncHandler(async (req, res) => {
    res.json(await businessesService.getBusiness(await getAccess(req), req.params.id));
  }),
);

businessRouter.get(
  '/businesses/:id/branches',
  requireAuth,
  asyncHandler(async (req, res) => {
    res.json(await businessesService.listBranches(await getAccess(req), req.params.id));
  }),
);

businessRouter.get(
  '/branches/:id/groups',
  requireAuth,
  asyncHandler(async (req, res) => {
    res.json(await businessesService.listGroups(await getAccess(req), req.params.id));
  }),
);

businessRouter.get(
  '/groups/:id/departments',
  requireAuth,
  asyncHandler(async (req, res) => {
    res.json(await businessesService.listDepartmentsForGroup(await getAccess(req), req.params.id));
  }),
);
