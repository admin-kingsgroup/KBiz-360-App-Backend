import { Router } from 'express';
import { config, type AppConfig } from '../config';

// Force update. The app calls GET /api/app-version?platform=android|ios on every open and on every
// return to the foreground; when its own version is below `minVersion` it shows a blocking
// "Update required" screen that only opens the store. Public (an out-of-date app must be stopped
// before login too), so it returns nothing but the update policy. Mounted BEFORE chatRouter in
// app.ts (which user-JWT-gates all of /api).

export interface AppVersionPolicy {
  platform: 'android' | 'ios';
  minVersion: string | null; // null = no one is blocked
  storeUrl: string | null;
  notes: string[];
}

export function appVersionPolicy(platform: string | undefined, cfg: AppConfig['appUpdate']): AppVersionPolicy {
  const p = platform === 'ios' ? 'ios' : 'android';
  const side = cfg[p];
  return { platform: p, minVersion: side.minVersion ?? null, storeUrl: side.storeUrl ?? null, notes: cfg.notes };
}

export const appVersionRouter: Router = Router();

appVersionRouter.get('/', (req, res) => {
  const platform = typeof req.query.platform === 'string' ? req.query.platform : undefined;
  res.set('Cache-Control', 'no-store');
  res.json(appVersionPolicy(platform, config.appUpdate));
});
