// Augments Express Request with the authenticated principal set by requireAuth.
declare global {
  namespace Express {
    interface Request {
      auth?: { userId: string; role: string };
    }
  }
}

export {};
