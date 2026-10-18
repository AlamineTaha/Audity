import { SalesforceAuthService } from './authService';
import { SalesforceService } from './salesforceService';
import { AIService } from './aiService';
import { MonitorService } from './monitorService';
import { ReportService } from './reportService';

const intervalMinutes = parseInt(process.env.POLLING_INTERVAL_MINUTES || '10', 10);

// Shared singletons: one Redis client and one in-memory state per process.
export const authService = new SalesforceAuthService();
export const salesforceService = new SalesforceService(authService);
export const aiService = new AIService();
export const reportService = new ReportService();
export const monitorService = new MonitorService(
  salesforceService,
  aiService,
  authService,
  Number.isFinite(intervalMinutes) && intervalMinutes > 0 ? intervalMinutes : 10
);
