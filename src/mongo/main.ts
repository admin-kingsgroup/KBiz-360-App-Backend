import { createServer } from 'http';
import { createMongoApp } from './app';
import { config } from '../config';
import { connectMongo, disconnectMongo } from './connection';
import { initRealtime } from '../realtime/socket';
import { registerChatHandlers } from './chat/chat.socket';
import { registerCallHandlers } from './calls/call.socket';
import { ensureCallIndexes } from './calls/call.models';
import { ensureReminderIndexes } from './reminders/reminder.model';
import { ensureAttendanceIndexes } from './attendance/attendance.model';
import { ensureOfficeGeofenceIndexes } from './attendance/office.model';
import { ensureChatIndexes } from './chat/chat.models';
import { hydratePresence, startPresenceHeartbeat, stopPresenceHeartbeat } from './chat/chat.events';
import { ensureAlertIndexes } from './alerts/alert.service';
import { ensureClientErrorIndexes } from './clientErrors.router';
import { startEmailPolling } from '../email/email.poll';
import { startReminderDueSweep, stopReminderDueSweep } from './reminders/reminder.sweep';
import { startAttendanceDayClose, stopAttendanceDayClose } from './attendance/attendance.dayclose';
import { startAlertAttachmentSweep, stopAlertAttachmentSweep } from './alerts/alert.sweep';

// Entrypoint for the MongoDB-backed backend (real CRM auth + directory).
async function bootstrap(): Promise<void> {
  await connectMongo();
  // eslint-disable-next-line no-console
  console.log(`[kb360] mongo connected (crm=${config.mongo.crmDb}, app=${config.mongo.appDb})`);
  await ensureCallIndexes(); // call_logs / active_calls (TTL) / push_devices indexes
  await ensureReminderIndexes(); // reminders indexes
  await ensureAttendanceIndexes(); // attendance indexes
  await ensureOfficeGeofenceIndexes(); // office geofence (per-branch) indexes
  await ensureChatIndexes(); // conversation indexes (drops legacy unique deptKey → many groups per dept)
  await hydratePresence(); // last-seen Map survives restarts (user_presence is its durability)
  await ensureAlertIndexes(); // alert_events indexes (channel feed + newest-first listing)
  await ensureClientErrorIndexes(); // client crash reports (30d TTL)

  const app = createMongoApp();
  const httpServer = createServer(app);
  const io = initRealtime(httpServer);
  registerChatHandlers(io); // chat realtime (presence, rooms, typing, send/read/delivered)
  registerCallHandlers(io); // call realtime (WebRTC offer/answer/ICE relay)

  httpServer.listen(config.port, () => {
    // eslint-disable-next-line no-console
    console.log(`[kb360] mongo backend listening on :${config.port} (${config.env})`);
  });

  startEmailPolling(); // new-mail push (no-op until Microsoft email is configured + a user connects)
  startReminderDueSweep(); // "⏰ Reminder due" pushes for reminders whose due time arrives
  startAlertAttachmentSweep(); // reap stored alert PDFs before their event docs TTL out
  startPresenceHeartbeat(); // stamps lastSeenAt for online users every 60s (a crash loses ≤60s)
  startAttendanceDayClose(); // 10pm branch-wise attendance day-close summary to each attendance channel

  const shutdown = async (): Promise<void> => {
    stopReminderDueSweep();
    stopAlertAttachmentSweep();
    stopPresenceHeartbeat();
    stopAttendanceDayClose();
    await disconnectMongo();
    httpServer.close(() => process.exit(0));
  };
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());
}

void bootstrap();
