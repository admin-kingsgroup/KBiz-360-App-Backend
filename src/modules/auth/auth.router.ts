import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../common/asyncHandler';
import { validate } from '../../common/validate';
import { Unauthorized } from '../../common/errors';
import { requireAuth } from './auth.middleware';
import { authService } from './auth.service';

export const authRouter: Router = Router();

const loginSchema = z.object({
  identifier: z.string().min(1), // email, legacy user id, or canonical id (frontend "User ID")
  password: z.string().min(1),
});

const refreshSchema = z.object({ refreshToken: z.string().min(1) });

// POST /auth/login
authRouter.post(
  '/login',
  validate(loginSchema),
  asyncHandler(async (req, res) => {
    const { identifier, password } = req.body as z.infer<typeof loginSchema>;
    const session = await authService.login(identifier, password);
    res.json(session);
  }),
);

// POST /auth/refresh
authRouter.post(
  '/refresh',
  validate(refreshSchema),
  asyncHandler(async (req, res) => {
    const { refreshToken } = req.body as z.infer<typeof refreshSchema>;
    const tokens = await authService.refresh(refreshToken);
    res.json(tokens);
  }),
);

// POST /auth/logout
authRouter.post(
  '/logout',
  validate(refreshSchema),
  asyncHandler(async (req, res) => {
    const { refreshToken } = req.body as z.infer<typeof refreshSchema>;
    await authService.logout(refreshToken);
    res.status(204).send();
  }),
);

// GET /auth/me
authRouter.get(
  '/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    if (!req.auth) throw Unauthorized();
    const me = await authService.me(req.auth.userId);
    res.json(me);
  }),
);
