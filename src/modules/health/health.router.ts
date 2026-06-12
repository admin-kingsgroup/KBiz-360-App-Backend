import { Router } from 'express';
import { asyncHandler } from '../../common/asyncHandler';
import { prisma } from '../../db/prisma';

// Liveness + readiness. /health is liveness (process up); /health/ready pings the DB.
export const healthRouter: Router = Router();

healthRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    res.json({ status: 'ok', service: 'kb360-backend', ts: Date.now() });
  }),
);

healthRouter.get(
  '/ready',
  asyncHandler(async (_req, res) => {
    let db = false;
    try {
      await prisma.$queryRaw`SELECT 1`;
      db = true;
    } catch {
      db = false;
    }
    res.status(db ? 200 : 503).json({ status: db ? 'ready' : 'degraded', db });
  }),
);
