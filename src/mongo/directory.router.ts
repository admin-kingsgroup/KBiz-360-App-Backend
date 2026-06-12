import { Router, type Request } from 'express';
import { asyncHandler } from '../common/asyncHandler';
import { Unauthorized, NotFound } from '../common/errors';
import { requireAuth } from './middleware';
import { accessService, type MongoAccess } from './access';
import { directoryService } from './directory.service';

// Read-only directory of the CRM (users / companies / branches / departments), access-scoped.
export const directoryRouter: Router = Router();

async function getAccess(req: Request): Promise<MongoAccess> {
  if (!req.auth) throw Unauthorized();
  const access = await accessService.accessForUserId(req.auth.userId);
  if (!access) throw Unauthorized('Session user not found');
  return access;
}

directoryRouter.get(
  '/users',
  requireAuth,
  asyncHandler(async (req, res) => {
    res.json(await directoryService.listUsers(await getAccess(req)));
  }),
);

directoryRouter.get(
  '/users/:id',
  requireAuth,
  asyncHandler(async (req, res) => {
    const u = await directoryService.getUser(await getAccess(req), req.params.id);
    if (!u) throw NotFound('User not found or out of scope');
    res.json(u);
  }),
);

directoryRouter.get(
  '/companies',
  requireAuth,
  asyncHandler(async (req, res) => {
    res.json(await directoryService.listCompanies(await getAccess(req)));
  }),
);

directoryRouter.get(
  '/roles',
  requireAuth,
  asyncHandler(async (req, res) => {
    res.json(await directoryService.listRoles(await getAccess(req)));
  }),
);

directoryRouter.get(
  '/branches',
  requireAuth,
  asyncHandler(async (req, res) => {
    res.json(await directoryService.listBranches(await getAccess(req)));
  }),
);

directoryRouter.get(
  '/departments',
  requireAuth,
  asyncHandler(async (req, res) => {
    const branchId = typeof req.query.branchId === 'string' ? req.query.branchId : undefined;
    res.json(await directoryService.listDepartments(await getAccess(req), branchId));
  }),
);
