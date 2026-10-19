/**
 * Application Entry Point
 * Initializes PostgreSQL, Redis, services, and starts the Express server.
 */

import dotenv from 'dotenv';
dotenv.config();

import { Server } from 'http';
import app from './app';
import { DatabaseService } from './services/databaseService';
import { auditArchiveService, authService, monitorService, privilegeService, setDatabase } from './services/container';
import { initTenantAuth } from './middleware/tenantAuth';
import { initSlackStore } from './slack/store';

const PORT = parseInt(process.env.PORT || '3000', 10);
const POLLING_ENABLED = String(process.env.POLLING_ENABLED ?? 'true').toLowerCase() === 'true';

async function startServer() {
  let server: Server | null = null;
  let dbService: DatabaseService | null = null;

  const shutdown = async (signal: string) => {
    console.log(`${signal} received, shutting down gracefully...`);
    monitorService.stop();
    if (server) {
      server.close((err) => {
        if (err) console.error('Error closing server:', err);
      });
    }
    await authService.disconnect();
    if (dbService) await dbService.disconnect();
    process.exit(0);
  };

  process.on('SIGTERM', async () => { await shutdown('SIGTERM'); });
  process.on('SIGINT', async () => { await shutdown('SIGINT'); });

  try {
    // 1. Initialize PostgreSQL
    dbService = new DatabaseService();
    await dbService.initialize();
    console.log('[Startup] PostgreSQL connected and schema initialized');

    // 2. Initialize Redis + wire database into the shared auth service
    authService.setDatabaseService(dbService);
    await authService.connect();
    console.log('[Startup] Redis connected');

    // 3. Initialize tenant auth middleware
    initTenantAuth(dbService, authService);
    initSlackStore(dbService);
    setDatabase(dbService);
    monitorService.addOrgCycleHook('audit-archive', (orgId) => auditArchiveService.sync(orgId));
    monitorService.addOrgCycleHook('privileged-access', (orgId) => privilegeService.check(orgId));
    console.log('[Startup] Tenant auth middleware initialized');

    // 4. Start change monitoring
    if (POLLING_ENABLED) {
      monitorService.start();
    } else {
      console.warn('[Startup] Polling disabled (POLLING_ENABLED=false)');
    }

    // 5. Start HTTP server
    server = app.listen(PORT, () => {
      console.log(`AuditDelta server running on port ${PORT}`);
      console.log(`API Documentation: http://localhost:${PORT}/api-docs`);
      console.log(`Health Check: http://localhost:${PORT}/api/v1/health`);
      console.log(`Authenticate: http://localhost:${PORT}/auth/authorize`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

startServer();
