import express, { type Express } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { mongoAuthRouter } from './auth.router';
import { directoryRouter } from './directory.router';
import { adminRouter } from './admin.router';
import { chatRouter } from './chat/chat.router';
import { callsRouter } from './calls/calls.router';
import { remindersRouter } from './reminders/reminders.router';
import { attendanceRouter } from './attendance/attendance.router';
import { alertsRouter } from './alerts/alerts.router';
import { uploadsRouter } from './uploads.router';
import { emailRouter } from '../email/email.router';
import { config } from '../config';
import { errorHandler, NotFound } from '../common/errors';
import { PRIVACY_HTML } from './privacy';

// Express app backed by MongoDB: real auth (CRM read-only) + directory reads.
// App-owned writes (sessions, and later reminders/attendance/chat) go to the kb360_app database.
export function createMongoApp(): Express {
  const app = express();
  app.use(helmet());
  app.use(cors());
  app.use(express.json({ limit: '20mb' })); // headroom for base64 email attachments (per-file 10 MB, ~14 MB total)

  app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'kb360-backend (mongo)', ts: Date.now() }));
  app.get('/privacy', (_req, res) => res.type('html').send(PRIVACY_HTML)); // public: linked from the Play Store listing
  app.use('/api/auth', mongoAuthRouter);
  app.use('/api/admin', adminRouter); // super-admin: app-access toggles
  app.use('/api', directoryRouter); // /users, /companies, /branches, /departments
  app.use('/api', chatRouter); // /conversations, /messages, /groups
  app.use('/api', callsRouter); // /calls/* (audio calling: signaling REST + history + analytics)
  app.use('/api/reminders', remindersRouter); // reminders (CRUD + review/approval, real users)
  app.use('/api/attendance', attendanceRouter); // attendance (punch in/out + today + team)
  app.use('/api/alerts', alertsRouter); // system alerts (Home feed, access-filtered per user)
  app.use('/api', uploadsRouter); // /uploads (chat media)
  app.use('/api', emailRouter); // /email/* (Microsoft 365 via Graph)
  app.use('/uploads', express.static(config.storage.localDir)); // serve locally-stored media

  app.use((req, _res, next) => next(NotFound(`No route for ${req.method} ${req.path}`)));
  app.use(errorHandler);
  return app;
}
