import { Router, type Request } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../common/asyncHandler';
import { validate } from '../common/validate';
import { Unauthorized, NotFound } from '../common/errors';
import { requireAuth, requireSuper } from './middleware';
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
    const access = await getAccess(req);
    // Disabled (app-access-off) users are hidden by default; only a super-admin (the admin Team &
    // Users screen) may include them via ?includeDisabled=1 so they can be re-enabled.
    const includeDisabled = req.query.includeDisabled === '1' && access.isSuper;
    res.json(await directoryService.listUsers(access, { includeDisabled }));
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

// Super-admin department management (app-created departments; the CRM is read-only).
const uid = (req: Request): string => { if (!req.auth) throw Unauthorized(); return req.auth.userId; };
const deptBody = z.object({
  name: z.string().min(1).max(80),
  companyId: z.string().nullable().optional(),
  branchId: z.string().nullable().optional(),
  icon: z.string().max(8).nullable().optional(),
  color: z.string().max(16).nullable().optional(),
});
directoryRouter.get('/departments/app', requireAuth, requireSuper,
  asyncHandler(async (req, res) => res.json(await directoryService.listAppDepartments(await getAccess(req)))));

// Super-admin: create a business (writes to the CRM companies collection).
directoryRouter.post('/companies', requireAuth, requireSuper, validate(z.object({ name: z.string().min(1).max(120) })),
  asyncHandler(async (req, res) => res.status(201).json(await directoryService.createCompany(uid(req), req.body))));

// Super-admin: create a branch under a business (writes to the CRM branches collection).
// userIds: optional team members to add to the new branch at creation time.
directoryRouter.post('/branches', requireAuth, requireSuper, validate(z.object({
  companyId: z.string().min(1),
  name: z.string().min(1).max(120),
  code: z.string().min(1).max(20),
  city: z.string().max(80).optional(),
  country: z.string().max(80).optional(),
  isHO: z.boolean().optional(),
  userIds: z.array(z.string()).max(500).optional(),
})), asyncHandler(async (req, res) => res.status(201).json(await directoryService.createBranch(uid(req), req.body))));

// ── User provisioning (super-admin; writes to the CRM users collection) ──
const userBody = z.object({
  email: z.string().email(),
  password: z.string().min(6).optional(),
  firstName: z.string().max(80).optional(),
  lastName: z.string().max(80).optional(),
  phone: z.string().max(40).nullable().optional(),
  roleId: z.string().optional(),
  branchIds: z.array(z.string()).optional(),
  status: z.string().optional(),
});
directoryRouter.post('/users', requireAuth, requireSuper, validate(userBody.extend({ password: z.string().min(6) })),
  asyncHandler(async (req, res) => res.status(201).json(await directoryService.createUser(uid(req), req.body))));
directoryRouter.put('/users/:id', requireAuth, requireSuper, validate(userBody.partial()),
  asyncHandler(async (req, res) => res.json(await directoryService.updateUser(uid(req), req.params.id, req.body))));

// A user editing their own profile (name / phone).
directoryRouter.put('/me/profile', requireAuth, validate(z.object({ firstName: z.string().max(80).optional(), lastName: z.string().max(80).optional(), phone: z.string().max(40).nullable().optional() })),
  asyncHandler(async (req, res) => res.json(await directoryService.updateOwnProfile(uid(req), req.body))));

// A user setting their own profile picture (url from /api/uploads). null clears it.
directoryRouter.put('/me/avatar', requireAuth, validate(z.object({ url: z.string().nullable() })),
  asyncHandler(async (req, res) => res.json(await directoryService.setOwnAvatar(uid(req), req.body.url))));

// A user changing their own password.
directoryRouter.put('/me/password', requireAuth, validate(z.object({ currentPassword: z.string().min(1), newPassword: z.string().min(6) })),
  asyncHandler(async (req, res) => res.json(await directoryService.changeOwnPassword(uid(req), req.body.currentPassword, req.body.newPassword))));

// ── KBiz360 · BOM membership (super-admin) — all tenant users with a member flag + a toggle.
// The GET ensures the KBiz360 business has its single BOM branch (created on first call).
directoryRouter.get('/kbiz/membership', requireAuth, requireSuper,
  asyncHandler(async (req, res) => res.json(await directoryService.kbizMembership(uid(req)))));
directoryRouter.put('/kbiz/membership/:userId', requireAuth, requireSuper, validate(z.object({ member: z.boolean() })),
  asyncHandler(async (req, res) => res.json(await directoryService.setKbizMembership(uid(req), req.params.userId, req.body.member))));

// Super-admin: edit a role's permission list (writes to the CRM roles collection).
directoryRouter.put('/roles/:id/permissions', requireAuth, requireSuper, validate(z.object({ permissions: z.array(z.string()) })),
  asyncHandler(async (req, res) => res.json(await directoryService.setRolePermissions(uid(req), req.params.id, req.body.permissions))));
directoryRouter.post('/departments', requireAuth, requireSuper, validate(deptBody),
  asyncHandler(async (req, res) => res.status(201).json(await directoryService.createDepartment(uid(req), req.body))));
directoryRouter.put('/departments/:id', requireAuth, requireSuper, validate(deptBody.partial()),
  asyncHandler(async (req, res) => res.json(await directoryService.updateDepartment(uid(req), req.params.id, req.body))));
directoryRouter.delete('/departments/:id', requireAuth, requireSuper,
  asyncHandler(async (req, res) => res.json(await directoryService.deleteDepartment(uid(req), req.params.id))));
