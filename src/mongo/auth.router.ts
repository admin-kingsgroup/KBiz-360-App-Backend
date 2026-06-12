import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../common/asyncHandler';
import { validate } from '../common/validate';
import { Unauthorized } from '../common/errors';
import { requireAuth } from './middleware';
import { mongoAuth } from './auth';

export const mongoAuthRouter: Router = Router();

const loginSchema = z.object({ identifier: z.string().min(1), password: z.string().min(1) });
const refreshSchema = z.object({ refreshToken: z.string().min(1) });

mongoAuthRouter.post(
  '/login',
  validate(loginSchema),
  asyncHandler(async (req, res) => {
    const { identifier, password } = req.body as z.infer<typeof loginSchema>;
    res.json(await mongoAuth.login(identifier, password));
  }),
);

mongoAuthRouter.post(
  '/refresh',
  validate(refreshSchema),
  asyncHandler(async (req, res) => {
    res.json(await mongoAuth.refresh((req.body as z.infer<typeof refreshSchema>).refreshToken));
  }),
);

mongoAuthRouter.post(
  '/logout',
  validate(refreshSchema),
  asyncHandler(async (req, res) => {
    await mongoAuth.logout((req.body as z.infer<typeof refreshSchema>).refreshToken);
    res.status(204).send();
  }),
);

mongoAuthRouter.get(
  '/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    if (!req.auth) throw Unauthorized();
    res.json(await mongoAuth.me(req.auth.userId));
  }),
);
