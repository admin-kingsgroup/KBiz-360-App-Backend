import express, { type Express } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { mongoAuthRouter } from './auth.router';
import { directoryRouter } from './directory.router';
import { adminRouter } from './admin.router';
import { chatRouter } from './chat/chat.router';
import { callsRouter } from './calls/calls.router';
import { remindersRouter } from './reminders/reminders.router';
import { remindersServiceRouter } from './reminders/remindersService.router';
import { attendanceRouter } from './attendance/attendance.router';
import { locationRouter } from './location/location.router';
import { hrRouter } from './hr/hr.router';
import { approvalsRouter } from './approvals/approvals.router';
import { erpRouter } from './erp/erp.router';
import { alertsRouter } from './alerts/alerts.router';
import { alertsIngestRouter } from './alerts/alertsIngest.router';
import { clientErrorsRouter } from './clientErrors.router';
import { appVersionRouter } from './appVersion.router';
import { uploadsRouter } from './uploads.router';
import { emailRouter } from '../email/email.router';
import { proxyEmailImage } from '../email/imageProxy';
import { asyncHandler } from '../common/asyncHandler';
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
  app.use('/api/alerts', alertsIngestRouter); // ERP/CRM service-token ingest — MUST precede chatRouter's /api-wide requireAuth
  app.use('/api/service/reminders', remindersServiceRouter); // ERP reads/writes the app's reminders as its own user (service token) — also pre-chatRouter
  app.use('/api/client-errors', clientErrorsRouter); // crash reports (public, rate-limited) — also pre-chatRouter
  app.use('/api/app-version', appVersionRouter); // force-update policy (public: an old app is stopped before login) — also pre-chatRouter
  // Signed email-image proxy — also pre-chatRouter: <img> tags in the mail WebView cannot attach
  // the JWT; the HMAC in the URL (minted server-side in getMessage) is the auth.
  app.get('/api/email/img', asyncHandler(proxyEmailImage));
  app.use('/api/admin', adminRouter); // super-admin: app-access toggles
  app.use('/api', directoryRouter); // /users, /companies, /branches
  app.use('/api', chatRouter); // /conversations, /messages, /groups
  app.use('/api', callsRouter); // /calls/* (audio calling: signaling REST + history + analytics)
  app.use('/api/reminders', remindersRouter); // reminders (CRUD + review/approval, real users)
  app.use('/api/attendance', attendanceRouter); // attendance (punch in/out + today + team)
  app.use('/api/location', locationRouter); // work-hours location trail (device pings + live roster + day trail)
  app.use('/api/hr', hrRouter); // HR self-service (leave balance/applications + regularisation requests)
  app.use('/api/approvals', approvalsRouter); // approval requests (chain of levels the requester builds; one or more approvers per level)
  app.use('/api/erp', erpRouter); // ERP approvals for ERP approvers, forwarded to the ERP's app door as the signed-in user
  app.use('/api/alerts', alertsRouter); // system alerts (Home feed, access-filtered per user)
  app.use('/api', uploadsRouter); // /uploads (chat media)
  app.use('/api', emailRouter); // /email/* (Microsoft 365 via Graph)
  // Locally-stored media. helmet's default Cross-Origin-Resource-Policy (same-origin) would stop
  // the ERP web app — a different origin — from showing a reminder's screenshot in an <img>.
  app.use('/uploads', express.static(config.storage.localDir, { setHeaders: (res) => { res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin'); } }));

  app.use((req, _res, next) => next(NotFound(`No route for ${req.method} ${req.path}`)));
  app.use(errorHandler);
  return app;
}
