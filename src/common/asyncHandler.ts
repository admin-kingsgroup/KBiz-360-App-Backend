import type { Request, Response, NextFunction, RequestHandler } from 'express';

// Wraps an async route handler so rejected promises reach the Express error middleware.
export const asyncHandler =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler =>
  (req, res, next) => {
    fn(req, res, next).catch(next);
  };
