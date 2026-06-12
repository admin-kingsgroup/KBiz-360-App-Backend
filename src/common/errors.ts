import type { ErrorRequestHandler, Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';

// Application error with an HTTP status. Thrown by services/handlers; caught by errorHandler.
export class AppError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code?: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const NotFound = (msg = 'Not found'): AppError => new AppError(404, msg, 'NOT_FOUND');
export const Unauthorized = (msg = 'Unauthorized'): AppError => new AppError(401, msg, 'UNAUTHORIZED');
export const Forbidden = (msg = 'Forbidden'): AppError => new AppError(403, msg, 'FORBIDDEN');
export const BadRequest = (msg = 'Bad request'): AppError => new AppError(400, msg, 'BAD_REQUEST');

// Centralized error handler. Must be registered LAST (after all routers).
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export const errorHandler: ErrorRequestHandler = (err, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof ZodError) {
    res.status(400).json({ error: { code: 'VALIDATION', message: 'Validation failed', details: err.flatten() } });
    return;
  }
  if (err instanceof AppError) {
    res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
    return;
  }
  const message = err instanceof Error ? err.message : 'Internal server error';
  res.status(500).json({ error: { code: 'INTERNAL', message } });
};
