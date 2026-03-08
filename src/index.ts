/**
 * Application Entry Point
 * Initializes PostgreSQL, Redis, services, and starts the Express server.
 */

import dotenv from 'dotenv';
dotenv.config();

import { Server } from 'http';
import app from './app';
import { DatabaseService } from './services/databaseService';
import { SalesforceAuthService } from './services/authService';
import { SalesforceService } from './services/salesforceService';
import { AIService } from './services/aiService';
import { PollingService } from './services/pollingService';
import { initTenantAuth } from './middleware/tenantAuth';
import { ensureWaitingRoomStarted } from './routes/monitoring';
import { authService as routeAuthService } from './routes/auth';

const PORT = parseInt(process.env.PORT || '3000', 10);

async function startServer() {
  let server: Server | null = null;
  let authService: SalesforceAuthService | null = null;
  let dbService: DatabaseService | null = null;
  let pollingService: PollingService | null = null;

  const shutdown = async (signal: string) => {
    console.log(`${signal} received, shutting down gracefully...`);
    if (pollingService) pollingService.stop();
    if (server) {
      server.close((err) => {
        if (err) console.error('Error closing server:', err);
      });
    }
    if (authService) await authService.disconnect();
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

    // 2. Initialize Redis + wire database into auth service
    authService = new SalesforceAuthService();
    authService.setDatabaseService(dbService);
    await authService.connect();
    console.log('[Startup] Redis connected');

    // Wire DB into the auth service instance used by auth routes
    routeAuthService.setDatabaseService(dbService);

    // 3. Initialize tenant auth middleware
    initTenantAuth(dbService, authService);
    console.log('[Startup] Tenant auth middleware initialized');

    // 4. Start background services
    const salesforceService = new SalesforceService(authService);
    const aiService = new AIService();

    pollingService = new PollingService(salesforceService, aiService, authService);
    pollingService.start();

    await ensureWaitingRoomStarted();

    // Periodic cleanup of dedup keys
    setInterval(async () => {
      try {
        await authService!.cleanupAuditProcessedKeys();
      } catch (err) {
        console.error('[Startup] audit_processed cleanup failed:', err);
      }
    }, 24 * 60 * 60 * 1000);

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
