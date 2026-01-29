/**
 * Polling Service
 * Runs scheduled checks for Salesforce automation changes
 */

import * as cron from 'node-cron';
import { SalesforceService } from './salesforceService';
import { AIService } from './aiService';
import { SlackService } from './slackService';
import { SalesforceAuthService } from './authService';
import { SetupAuditTrail } from '../types';

export class PollingService {
  private salesforceService: SalesforceService;
  private aiService: AIService;
  private slackService: SlackService;
  private authService: SalesforceAuthService;
  private cronExpression: string;
  private isRunning: boolean = false;

  constructor(
    salesforceService: SalesforceService,
    aiService: AIService,
    slackService: SlackService,
    authService: SalesforceAuthService,
    cronExpression: string = '*/10 * * * *' // Every 10 minutes
  ) {
    this.salesforceService = salesforceService;
    this.aiService = aiService;
    this.slackService = slackService;
    this.authService = authService;
    this.cronExpression = cronExpression;
  }

  /**
   * Start the polling service
   */
  start(): void {
    if (this.isRunning) {
      console.warn('Polling service is already running');
      return;
    }

    console.log(`Starting polling service with schedule: ${this.cronExpression}`);
    cron.schedule(this.cronExpression, async () => {
      await this.poll();
    });

    this.isRunning = true;
  }

  /**
   * Stop the polling service
   */
  stop(): void {
    this.isRunning = false;
    console.log('Polling service stopped');
  }

  /**
   * Main polling logic
   */
  private async poll(): Promise<void> {
    try {
      console.log('Starting audit trail poll...');

      // Get all registered orgs (simplified - in production, maintain a registry)
      // For now, we'll need to track orgs separately
      const orgIds: string[] = await this.authService.getAllOrgIds();

      for (const orgId of orgIds) {
        await this.processOrg(orgId);
      }
    } catch (error) {
      console.error('Error in polling service:', error);
    }
  }

  /**
   * Process changes for a specific org
   */
  private async processOrg(orgId: string): Promise<void> {
    try {
      const auditRecords = await this.salesforceService.queryAuditTrail(orgId, 10);

      for (const record of auditRecords) {
        if (record.Action === 'ChangedFlow') {
          await this.processFlowChange(orgId, record);
        } else if (record.Action === 'ManagedContent' || record.Action === 'PublishKnowledge') {
          await this.processCMSChange(orgId, record);
        }
      }
    } catch (error) {
      console.error(`Error processing org ${orgId}:`, error);
    }
  }

  /**
   * Process Flow change
   */
  private async processFlowChange(orgId: string, auditRecord: SetupAuditTrail): Promise<void> {
    try {
      // Extract flow name from Display field (format: "Flow: FlowName")
      const display = auditRecord.Display || '';
      const flowNameMatch = display.match(/Flow:\s*(.+)/);
      if (!flowNameMatch) {
        console.warn(`Could not extract flow name from: ${display}`);
        return;
      }

      const flowName = flowNameMatch[1].trim();

      // Get flow versions
      const versions = await this.salesforceService.getFlowVersions(orgId, flowName);

      // Get org settings for billing mode
      const settings = await this.authService.getOrgSettings(orgId);
      if (!settings) {
        throw new Error(`No settings found for orgId: ${orgId}`);
      }

      // Generate AI summary
      const diff = await this.aiService.generateSummary(
        versions.previous,
        versions.current,
        flowName,
        settings
      );

      // Send Slack notification
      await this.slackService.sendFlowChangeNotification(diff);
    } catch (error) {
      console.error(`Error processing flow change:`, error);
    }
  }

  /**
   * Process CMS change
   */
  private async processCMSChange(orgId: string, auditRecord: SetupAuditTrail): Promise<void> {
    // CMS change processing - log for monitoring
    console.log('CMS change detected, processing...');
  }
}

