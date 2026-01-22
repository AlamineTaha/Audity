/**
 * Monitor Service
 * Orchestrates proactive monitoring of Salesforce changes
 * Runs scheduled checks and can be triggered manually
 */

import * as cron from 'node-cron';
import { SalesforceService } from './salesforceService';
import { AIService } from './aiService';
import { SlackService } from './slackService';
import { SalesforceAuthService } from './authService';
import { SetupAuditTrail, OrgSettings } from '../types';

export class MonitorService {
  private salesforceService: SalesforceService;
  private aiService: AIService;
  private slackService: SlackService;
  private authService: SalesforceAuthService;
  private cronJob: cron.ScheduledTask | null = null;
  private isRunning: boolean = false;
  private checkIntervalMinutes: number;

  constructor(
    salesforceService: SalesforceService,
    aiService: AIService,
    slackService: SlackService,
    authService: SalesforceAuthService,
    checkIntervalMinutes: number = 10
  ) {
    this.salesforceService = salesforceService;
    this.aiService = aiService;
    this.slackService = slackService;
    this.authService = authService;
    this.checkIntervalMinutes = checkIntervalMinutes;
  }

  /**
   * Start the scheduled monitoring
   * Runs runChangeCheck() every X minutes (default: 10)
   */
  start(): void {
    if (this.isRunning) {
      console.warn('Monitor service is already running');
      return;
    }

    // Convert minutes to cron expression (every X minutes)
    const cronExpression = `*/${this.checkIntervalMinutes} * * * *`;
    
    console.log(`Starting monitor service with schedule: ${cronExpression} (every ${this.checkIntervalMinutes} minutes)`);
    
    this.cronJob = cron.schedule(cronExpression, async () => {
      await this.runChangeCheck();
    });

    this.isRunning = true;
  }

  /**
   * Stop the scheduled monitoring
   */
  stop(): void {
    if (this.cronJob) {
      this.cronJob.stop();
      this.cronJob = null;
    }
    this.isRunning = false;
    console.log('Monitor service stopped');
  }

  /**
   * Run change check immediately
   * This is the main function that:
   * 1. Queries audit trail for changes in the last X minutes
   * 2. If changes found, analyzes them with AI
   * 3. Sends Slack alerts
   * 
   * Can be called manually via API endpoint
   */
  async runChangeCheck(): Promise<{ success: boolean; changesFound: number; errors: string[] }> {
    const errors: string[] = [];
    let changesFound = 0;

    try {
      console.log(`[Monitor] Starting change check (last ${this.checkIntervalMinutes} minutes)...`);

      // Get all registered orgs from Redis
      // Note: In production, you might want to maintain a separate org registry
      // For now, we'll need to track orgs - this is a simplified approach
      const orgIds = await this.getRegisteredOrgIds();

      if (orgIds.length === 0) {
        console.log('[Monitor] No registered organizations found');
        return { success: true, changesFound: 0, errors: [] };
      }

      for (const orgId of orgIds) {
        try {
          const changes = await this.processOrgChanges(orgId);
          changesFound += changes;
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : 'Unknown error';
          errors.push(`Error processing org ${orgId}: ${errorMsg}`);
          console.error(`[Monitor] Error processing org ${orgId}:`, error);
        }
      }

      console.log(`[Monitor] Change check completed. Found ${changesFound} change(s)`);
      return { success: true, changesFound, errors };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      errors.push(`Monitor error: ${errorMsg}`);
      console.error('[Monitor] Error in runChangeCheck:', error);
      return { success: false, changesFound, errors };
    }
  }

  /**
   * Get list of registered organization IDs
   */
  private async getRegisteredOrgIds(): Promise<string[]> {
    try {
      return await this.authService.getAllOrgIds();
    } catch (error) {
      console.error('[Monitor] Error getting registered orgs:', error);
      return [];
    }
  }

  /**
   * Process changes for a specific organization
   */
  private async processOrgChanges(orgId: string): Promise<number> {
    let changesProcessed = 0;

    try {
      // Query audit trail for changes in the last X minutes
      const auditRecords = await this.salesforceService.queryAuditTrail(orgId, this.checkIntervalMinutes);

      if (auditRecords.length === 0) {
        return 0;
      }

      console.log(`[Monitor] Found ${auditRecords.length} audit record(s) for org ${orgId}`);

      // Get org settings for billing mode
      const settings = await this.authService.getOrgSettings(orgId);
      if (!settings) {
        throw new Error(`No settings found for orgId: ${orgId}`);
      }

      // Process each change
      for (const record of auditRecords) {
        try {
          if (this.isFlowChange(record)) {
            await this.processFlowChange(orgId, record, settings);
            changesProcessed++;
          } else if (this.isPermissionChange(record)) {
            await this.processPermissionChange(orgId, record, settings);
            changesProcessed++;
          } else if (this.isObjectChange(record)) {
            await this.processObjectChange(orgId, record, settings);
            changesProcessed++;
          }
        } catch (error) {
          console.error(`[Monitor] Error processing change ${record.Id}:`, error);
        }
      }
    } catch (error) {
      console.error(`[Monitor] Error processing org ${orgId}:`, error);
      throw error;
    }

    return changesProcessed;
  }

  /**
   * Check if audit record is a Flow change
   */
  private isFlowChange(record: SetupAuditTrail): boolean {
    return record.Action?.toLowerCase().includes('flow') || false;
  }

  /**
   * Check if audit record is a Permission change
   */
  private isPermissionChange(record: SetupAuditTrail): boolean {
    return record.Action?.toLowerCase().includes('permission') || false;
  }

  /**
   * Check if audit record is an Object change
   */
  private isObjectChange(record: SetupAuditTrail): boolean {
    return record.Action?.toLowerCase().includes('object') || false;
  }

  /**
   * Process Flow change
   */
  private async processFlowChange(orgId: string, auditRecord: SetupAuditTrail, settings: OrgSettings): Promise<void> {
    try {
      // Extract flow name from Display field (format: "Flow: FlowName" or similar)
      const display = auditRecord.Display || '';
      const flowNameMatch = display.match(/Flow[:\s]+(.+)/i) || display.match(/^(.+)$/);
      
      if (!flowNameMatch) {
        console.warn(`[Monitor] Could not extract flow name from: ${display}`);
        return;
      }

      const flowName = flowNameMatch[1].trim();

      // Get flow versions
      const versions = await this.salesforceService.getFlowVersions(orgId, flowName);

      // Generate AI summary
      const diff = await this.aiService.generateSummary(
        versions.previous,
        versions.current,
        flowName,
        settings
      );

      // Send Slack notification
      await this.slackService.sendChangeNotification({
        type: 'Flow',
        changeType: 'Flow Change',
        user: auditRecord.CreatedBy.Name,
        timestamp: auditRecord.CreatedDate,
        orgId,
        summary: diff.summary,
        changes: diff.changes,
        riskLevel: this.determineRiskLevel(diff.summary),
        salesforceUrl: `${settings.instanceUrl}/lightning/setup/Flows/home`,
      });
    } catch (error) {
      console.error(`[Monitor] Error processing flow change:`, error);
      throw error;
    }
  }

  /**
   * Process Permission change
   */
  private async processPermissionChange(orgId: string, auditRecord: SetupAuditTrail, settings: OrgSettings): Promise<void> {
    // For now, send a basic notification
    // In the future, you could analyze permission changes more deeply
    await this.slackService.sendChangeNotification({
      type: 'Permission',
      changeType: 'Permission Change',
      user: auditRecord.CreatedBy.Name,
      timestamp: auditRecord.CreatedDate,
      orgId,
      summary: `Permission change detected: ${auditRecord.Display || auditRecord.Action}`,
      changes: [auditRecord.Display || auditRecord.Action],
      riskLevel: 'Medium',
      salesforceUrl: `${settings.instanceUrl}/lightning/setup/Security/home`,
    });
  }

  /**
   * Process Object change
   */
  private async processObjectChange(orgId: string, auditRecord: SetupAuditTrail, settings: OrgSettings): Promise<void> {
    // For now, send a basic notification
    await this.slackService.sendChangeNotification({
      type: 'Object',
      changeType: 'Object Change',
      user: auditRecord.CreatedBy.Name,
      timestamp: auditRecord.CreatedDate,
      orgId,
      summary: `Object change detected: ${auditRecord.Display || auditRecord.Action}`,
      changes: [auditRecord.Display || auditRecord.Action],
      riskLevel: 'Medium',
      salesforceUrl: `${settings.instanceUrl}/lightning/setup/ObjectManager/home`,
    });
  }

  /**
   * Determine risk level from AI summary
   */
  private determineRiskLevel(summary: string): 'Low' | 'Medium' | 'High' {
    const lowerSummary = summary.toLowerCase();
    
    if (lowerSummary.includes('security') || lowerSummary.includes('permission') || 
        lowerSummary.includes('access') || lowerSummary.includes('risk')) {
      return 'High';
    }
    
    if (lowerSummary.includes('delete') || lowerSummary.includes('remove') || 
        lowerSummary.includes('critical')) {
      return 'High';
    }
    
    if (lowerSummary.includes('update') || lowerSummary.includes('modify') || 
        lowerSummary.includes('change')) {
      return 'Medium';
    }
    
    return 'Low';
  }
}
