/**
 * Polling Service
 * Runs scheduled checks for Salesforce automation changes
 */

import * as cron from 'node-cron';
import { SalesforceService } from './salesforceService';
import { AIService } from './aiService';
import { SalesforceAuthService } from './authService';
import { SetupAuditTrail } from '../types';

export class PollingService {
  private salesforceService: SalesforceService;
  private aiService: AIService;
  private authService: SalesforceAuthService;
  private cronExpression: string;
  private isRunning: boolean = false;

  constructor(
    salesforceService: SalesforceService,
    aiService: AIService,
    authService: SalesforceAuthService,
    cronExpression: string = '*/10 * * * *' // Every 10 minutes
  ) {
    this.salesforceService = salesforceService;
    this.aiService = aiService;
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
        } else if (record.Action === 'changedValidationFormula' || record.Action?.toLowerCase().includes('validation')) {
          await this.processValidationRuleChange(orgId, record);
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

      // Build summary text for Slack (formatted for Salesforce Flow → Slack)
      const summaryText = `🚨 **Flow Change Detected: ${flowName}**\n\n` +
        `**Summary:**\n${diff.summary}\n\n` +
        `**Changes:**\n${diff.changes.map(c => `• ${c}`).join('\n')}\n\n` +
        `**Changed by:** ${auditRecord.CreatedBy?.Name || 'Unknown'}\n` +
        `**Time:** ${new Date(auditRecord.CreatedDate).toLocaleString()}\n` +
        `**View in Salesforce:** ${settings.instanceUrl}/lightning/setup/Flows/home`;

      // Publish to Salesforce custom object (triggers Flow → Slack via native integration)
      await this.salesforceService.publishAuditToSalesforce(orgId, summaryText, flowName);

      console.log(`[Polling] Published Flow change notification to Salesforce for: ${flowName}`);
    } catch (error) {
      console.error(`Error processing flow change:`, error);
    }
  }

  /**
   * Process CMS change
   */
  private async processCMSChange(_orgId: string, _auditRecord: SetupAuditTrail): Promise<void> {
    // CMS change processing - log for monitoring
    console.log('CMS change detected, processing...');
  }

  /**
   * Process Validation Rule change
   * Fetches the formula, gets Gemini interpretation, and publishes to Salesforce
   */
  private async processValidationRuleChange(orgId: string, auditRecord: SetupAuditTrail): Promise<void> {
    try {
      // Extract validation rule name from Display field
      // Format examples: "ValidationRule: RuleName", "Validation Rule: RuleName", etc.
      const display = auditRecord.Display || '';
      const ruleNameMatch = display.match(/(?:ValidationRule|Validation Rule):\s*(.+)/i);
      
      if (!ruleNameMatch) {
        console.warn(`Could not extract validation rule name from: ${display}`);
        return;
      }

      const ruleName = ruleNameMatch[1].trim();

      // Get org settings for billing mode
      const settings = await this.authService.getOrgSettings(orgId);
      if (!settings) {
        throw new Error(`No settings found for orgId: ${orgId}`);
      }

      // Fetch the full validation rule formula
      const formula = await this.salesforceService.getValidationRuleFormula(orgId, ruleName);
      
      if (!formula) {
        console.warn(`Could not fetch formula for validation rule: ${ruleName}`);
        return;
      }

      // Get Gemini interpretation of the formula
      const interpretation = await this.aiService.interpretValidationFormula(
        formula,
        ruleName,
        settings
      );

      // Build summary text for Slack
      const summaryText = `🔍 **Validation Rule Updated: ${ruleName}**\n\n` +
        `**Formula:**\n\`\`\`${formula}\`\`\`\n\n` +
        `**AI Interpretation:**\n${interpretation}\n\n` +
        `**Changed by:** ${auditRecord.CreatedBy.Name}\n` +
        `**Time:** ${new Date(auditRecord.CreatedDate).toLocaleString()}`;

      // Publish to Salesforce custom object (triggers Flow → Slack)
      await this.salesforceService.publishAuditToSalesforce(orgId, summaryText, ruleName);

      console.log(`[Polling] Processed validation rule change: ${ruleName}`);
    } catch (error) {
      console.error(`Error processing validation rule change:`, error);
    }
  }
}

