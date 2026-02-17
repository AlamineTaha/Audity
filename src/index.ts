/**
 * Application Entry Point
 * Initializes services and starts the Express server
 */

import dotenv from 'dotenv';
// Note: dotenv.config() is also called in app.ts to ensure env vars are loaded before routes
// This call here is redundant but ensures env vars are available even if app.ts is imported elsewhere
dotenv.config();

import app from './app';
import { SalesforceAuthService } from './services/authService';
import { SalesforceService } from './services/salesforceService';
import { AIService } from './services/aiService';
import { PollingService } from './services/pollingService';
import { ensureWaitingRoomStarted } from './routes/monitoring';

const PORT = process.env.PORT || 3000;

async function startServer() {
  try {
    // Initialize services
    const authService = new SalesforceAuthService();
    await authService.connect();

    const salesforceService = new SalesforceService(authService);
    const aiService = new AIService();

    // Initialize polling service (uses Salesforce native integration, no webhook needed)
    const pollingService = new PollingService(
      salesforceService,
      aiService,
      authService
    );

    // Start polling service
    pollingService.start();

    // Waiting Room Listener: Background process monitors Redis TTL
    // When a session expires (5 min), automatically triggers processAggregation
    await ensureWaitingRoomStarted();

    // Cleanup audit_processed keys every 24h
    setInterval(async () => {
      try {
        await authService.cleanupAuditProcessedKeys();
      } catch (err) {
        console.error('[Startup] audit_processed cleanup failed:', err);
      }
    }, 24 * 60 * 60 * 1000);

    // Start Express server
    app.listen(PORT, () => {
      console.log(`🚀 AuditDelta server running on port ${PORT}`);
      console.log(`📚 API Documentation: http://localhost:${PORT}/api-docs`);
      console.log(`🏥 Health Check: http://localhost:${PORT}/api/v1/health`);
    });

    // Graceful shutdown
    process.on('SIGTERM', async () => {
      console.log('SIGTERM received, shutting down gracefully...');
      pollingService.stop();
      await authService.disconnect();
      process.exit(0);
    });

    process.on('SIGINT', async () => {
      console.log('SIGINT received, shutting down gracefully...');
      pollingService.stop();
      await authService.disconnect();
      process.exit(0);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

startServer();

