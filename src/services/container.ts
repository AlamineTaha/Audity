import { SalesforceAuthService } from './authService';
import { SalesforceService } from './salesforceService';
import { AIService } from './aiService';
import { MonitorService } from './monitorService';
import { ReportService } from './reportService';
import { DatabaseService } from './databaseService';
import { AuditArchiveService } from './auditArchiveService';
import { PrivilegeService } from './privilegeService';

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
export const auditArchiveService = new AuditArchiveService();
export const privilegeService = new PrivilegeService();

let database: DatabaseService | null = null;

/** Set once at startup (the pool needs DATABASE_URL, so it isn't created at import time). */
export function setDatabase(db: DatabaseService): void {
  database = db;
}

export function getDatabase(): DatabaseService {
  if (!database) throw new Error('Database not initialized');
  return database;
}
