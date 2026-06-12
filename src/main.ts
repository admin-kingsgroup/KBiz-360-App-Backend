import { createServer } from 'http';
import { createApp } from './app';
import { config } from './config';
import { initRealtime } from './realtime/socket';
import { connectDb, disconnectDb } from './db/prisma';

// Process entrypoint: build the Express app, attach Socket.IO to the same HTTP server, listen.
async function bootstrap(): Promise<void> {
  const app = createApp();
  const httpServer = createServer(app);
  initRealtime(httpServer);

  try {
    await connectDb();
    // eslint-disable-next-line no-console
    console.log('[kb360] database connected');
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[kb360] database not connected at boot:', (err as Error).message);
  }

  httpServer.listen(config.port, () => {
    // eslint-disable-next-line no-console
    console.log(`[kb360] backend listening on :${config.port} (${config.env})`);
  });

  const shutdown = async (): Promise<void> => {
    await disconnectDb();
    httpServer.close(() => process.exit(0));
  };
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());
}

void bootstrap();
