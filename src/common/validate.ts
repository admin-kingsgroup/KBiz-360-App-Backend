import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { ZodSchema } from 'zod';

// Request validation middleware. Validates one of body/query/params against a zod schema and
// replaces the request property with the parsed (typed, coerced) value. Errors → errorHandler.
export const validate =
  (schema: ZodSchema, source: 'body' | 'query' | 'params' = 'body'): RequestHandler =>
  (req: Request, _res: Response, next: NextFunction) => {
    const result = schema.safeParse(req[source]);
    if (!result.success) {
      next(result.error);
      return;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (req as any)[source] = result.data;
    next();
  };
