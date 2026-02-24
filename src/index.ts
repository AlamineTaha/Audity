/**
 * Application Entry Point
 * Initializes services and starts the Express server
 */

import dotenv from 'dotenv';
// Note: dotenv.config() is also called in app.ts to ensure env vars are loaded before routes
// This call here is redundant but ensures env vars are available even if app.ts is imported elsewhere
dotenv.config();

import { Server } from 'http';
import app from './app';
import { SalesforceAuthService } from './services/authService';
import { SalesforceService } from './services/salesforceService';
import { AIService } from './services/aiService';
import { PollingService } from './services/pollingService';
import { ensureWaitingRoomStarted } from './routes/monitoring';

const PORT = parseInt(process.env.PORT || '3000', 10);

async function startServer() {
  let server: Server | null = null;
  let authService: SalesforceAuthService | null = null;
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
    process.exit(0);
  };

  process.on('SIGTERM', async () => { await shutdown('SIGTERM'); });
  process.on('SIGINT', async () => { await shutdown('SIGINT'); });

  try {
    authService = new SalesforceAuthService();
    await authService.connect();

    const salesforceService = new SalesforceService(authService);
    const aiService = new AIService();

    pollingService = new PollingService(
      salesforceService,
      aiService,
      authService
    );
    pollingService.start();

    await ensureWaitingRoomStarted();

    setInterval(async () => {
      try {
        await authService!.cleanupAuditProcessedKeys();
      } catch (err) {
        console.error('[Startup] audit_processed cleanup failed:', err);
      }
    }, 24 * 60 * 60 * 1000);

    server = app.listen(PORT, () => {
      console.log(`🚀 AuditDelta server running on port ${PORT}`);
      console.log(`📚 API Documentation: http://localhost:${PORT}/api-docs`);
      console.log(`🏥 Health Check: http://localhost:${PORT}/api/v1/health`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

startServer();

