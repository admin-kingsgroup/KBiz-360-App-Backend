import express, { Express } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { healthRouter } from './modules/health/health.router';
import { authRouter } from './modules/auth/auth.router';
import { usersRouter } from './modules/users/users.router';
import { businessRouter } from './modules/businesses/businesses.router';
import { remindersRouter } from './modules/reminders/reminders.router';
import { attendanceRouter } from './modules/attendance/attendance.router';
import { chatsRouter } from './modules/chats/chats.router';
import { notificationsRouter } from './modules/notifications/notifications.router';
import { uploadsRouter } from './modules/uploads/uploads.router';
import { auditRouter } from './modules/audit/audit.router';
import { config } from './config';
import { errorHandler, NotFound } from './common/errors';

// Express application factory. Feature routers (auth, users, businesses, reminders, attendance,
// chats, notifications, uploads, audit) mount under /api in their respective phases.
export function createApp(): Express {
  const app = express();

  app.use(helmet());
  app.use(cors());
  app.use(express.json({ limit: '5mb' }));
  app.use(express.urlencoded({ extended: true }));

  // --- routers ---
  app.use('/health', healthRouter);
  app.use('/api/auth', authRouter); // Phase 2 ✓
  app.use('/api/users', usersRouter); // Phase 3 ✓
  app.use('/api', businessRouter); // Phase 4 ✓ (/businesses, /branches, /groups)
  app.use('/api/reminders', remindersRouter); // Phase 5 ✓
  app.use('/api/attendance', attendanceRouter); // Phase 6 ✓
  app.use('/api', chatsRouter); // Phase 7 ✓ (/chats, /messages)
  app.use('/api/notifications', notificationsRouter); // Phase 8 ✓
  app.use('/api/uploads', uploadsRouter); // Phase 9 ✓
  app.use('/api/audit', auditRouter); // Phase 9 ✓
  // Serve locally-stored uploads (LocalStorageAdapter).
  app.use('/uploads', express.static(config.storage.localDir));

  // 404 + error handler (must be last)
  app.use((req, _res, next) => next(NotFound(`No route for ${req.method} ${req.path}`)));
  app.use(errorHandler);

  return app;
}
