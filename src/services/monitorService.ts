/**
 * Monitor Service
 * Orchestrates proactive monitoring of Salesforce changes
 * Runs scheduled checks and can be triggered manually
 */

import * as cron from 'node-cron';
import { SalesforceService } from './salesforceService';
import { AIService } from './aiService';
import { SalesforceAuthService } from './authService';
import { SetupAuditTrail, OrgSettings } from '../types';

export class MonitorService {
  private salesforceService: SalesforceService;
  private aiService: AIService;
  private authService: SalesforceAuthService;
  private cronJob: cron.ScheduledTask | null = null;
  private isRunning: boolean = false;
  private checkIntervalMinutes: number;

  constructor(
    salesforceService: SalesforceService,
    aiService: AIService,
    authService: SalesforceAuthService,
    checkIntervalMinutes: number = 10
  ) {
    this.salesforceService = salesforceService;
    this.aiService = aiService;
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
   * 1. Queries audit trail for changes in the last X minutes (or hours if specified)
   * 2. If changes found, analyzes them with AI
   * 3. Sends Slack alerts
   * 
   * Can be called manually via API endpoint
   * 
   * @param hours Optional: Look back X hours instead of using checkIntervalMinutes
   */
  async runChangeCheck(hours?: number): Promise<{ 
    success: boolean; 
    changesFound: number; 
    errors: string[];
    changes?: Array<{
      orgId: string;
      action: string;
      display: string;
      type: string;
      timestamp: string;
      user: string;
    }>;
  }> {
    const errors: string[] = [];
    let changesFound = 0;
    const changes: Array<{
      orgId: string;
      action: string;
      display: string;
      type: string;
      timestamp: string;
      user: string;
    }> = [];

    try {
      const timeWindow = hours 
        ? `${hours} hour(s)` 
        : `${this.checkIntervalMinutes} minute(s)`;
      console.log(`[Monitor] Starting change check (last ${timeWindow})...`);

      // Get all registered orgs from Redis
      // Note: In production, you might want to maintain a separate org registry
      // For now, we'll need to track orgs - this is a simplified approach
      const orgIds = await this.getRegisteredOrgIds();

      if (orgIds.length === 0) {
        console.log('[Monitor] No registered organizations found');
        return { success: true, changesFound: 0, errors: [], changes: [] };
      }

      for (const orgId of orgIds) {
        try {
          const result = await this.processOrgChanges(orgId, hours);
          changesFound += result.count;
          if (result.changes) {
            changes.push(...result.changes);
          }
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : 'Unknown error';
          errors.push(`Error processing org ${orgId}: ${errorMsg}`);
          console.error(`[Monitor] Error processing org ${orgId}:`, error);
        }
      }

      console.log(`[Monitor] Change check completed. Found ${changesFound} change(s)`);
      if (changes.length > 0) {
        console.log(`[Monitor] Changes detected:`, changes.map((c: { type: string; action: string }) => `${c.type}: ${c.action}`).join(', '));
      }
      return { success: true, changesFound, errors, changes };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      errors.push(`Monitor error: ${errorMsg}`);
      console.error('[Monitor] Error in runChangeCheck:', error);
      return { success: false, changesFound, errors, changes: [] };
    }
  }

  /**
   * Get list of registered organization IDs
   */
  private async getRegisteredOrgIds(): Promise<string[]> {
    try {
      const orgIds = await this.authService.getAllOrgIds();
      if (orgIds.length === 0) {
        console.warn('[Monitor] No organizations found in Redis. Make sure you have authenticated at least one org via /auth/authorize');
      } else {
        console.log(`[Monitor] Found ${orgIds.length} registered organization(s): ${orgIds.join(', ')}`);
      }
      return orgIds;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      console.error('[Monitor] Error getting registered orgs:', errorMsg);
      console.error('[Monitor] This might be a Redis connection issue. Check Redis is running and REDIS_PASSWORD is set if required.');
      return [];
    }
  }

  /**
   * Process changes for a specific organization
   * 
   * @param orgId Organization ID
   * @param hours Optional: Look back X hours instead of using checkIntervalMinutes
   */
  /**
   * Get change type category for a given audit record
   */
  private getChangeType(record: SetupAuditTrail): string {
    if (this.isFlowChange(record)) return 'Flow';
    if (this.isPermissionChange(record)) return 'Permission';
    if (this.isObjectChange(record)) return 'Object';
    if (this.isValidationChange(record)) return 'Validation Rule';
    if (this.isFormulaFieldChange(record)) return 'Formula Field';
    if (this.isMetadataChange(record)) return 'Metadata';
    return 'Unknown';
  }

  private async processOrgChanges(orgId: string, hours?: number): Promise<{
    count: number;
    changes: Array<{
      orgId: string;
      action: string;
      display: string;
      type: string;
      timestamp: string;
      user: string;
    }>;
  }> {
    let changesProcessed = 0;
    const changes: Array<{
      orgId: string;
      action: string;
      display: string;
      type: string;
      timestamp: string;
      user: string;
    }> = [];

    try {
      let auditRecords: SetupAuditTrail[];
      
      if (hours) {
        // Use hours-based query
        console.log(`[Monitor] Querying audit trail for org ${orgId} (last ${hours} hour(s))...`);
        auditRecords = await this.salesforceService.queryAuditTrailByHours(orgId, hours);
      } else {
        // Use minutes-based query (default)
        console.log(`[Monitor] Querying audit trail for org ${orgId} (last ${this.checkIntervalMinutes} minutes)...`);
        auditRecords = await this.salesforceService.queryAuditTrail(orgId, this.checkIntervalMinutes);
      }

      if (auditRecords.length === 0) {
        const timeWindow = hours ? `${hours} hour(s)` : `${this.checkIntervalMinutes} minutes`;
        console.log(`[Monitor] No audit records found for org ${orgId} in the last ${timeWindow}`);
        console.log(`[Monitor] Tip: Try using /api/v1/recent-changes?orgId=${orgId}&hours=24 to see all recent changes`);
        return { count: 0, changes: [] };
      }

      console.log(`[Monitor] Found ${auditRecords.length} audit record(s) for org ${orgId}`);
      console.log(`[Monitor] Actions detected: ${auditRecords.map(r => r.Action).join(', ')}`);

      // Get org settings for billing mode
      const settings = await this.authService.getOrgSettings(orgId);
      if (!settings) {
        throw new Error(`No settings found for orgId: ${orgId}`);
      }

      // Process each change
      for (const record of auditRecords) {
        try {
          const changeType = this.getChangeType(record);
          let processed = false;

          if (this.isFlowChange(record)) {
            await this.processFlowChange(orgId, record, settings);
            processed = true;
          } else if (this.isPermissionChange(record)) {
            await this.processPermissionChange(orgId, record, settings);
            processed = true;
          } else if (this.isObjectChange(record)) {
            await this.processObjectChange(orgId, record, settings);
            processed = true;
          } else if (this.isValidationChange(record)) {
            await this.processValidationChange(orgId, record, settings);
            processed = true;
          } else if (this.isFormulaFieldChange(record)) {
            await this.processFormulaFieldChange(orgId, record, settings);
            processed = true;
          } else if (this.isMetadataChange(record)) {
            await this.processMetadataChange(orgId, record, settings);
            processed = true;
          } else {
            // Unmapped actions are now ignored - only process known action types
            // Previously: We sent unmapped actions to LLM for interpretation
            // This was disabled because it generated too many notifications
            // Only Flow, Permission, Object, Validation Rule, Formula Field, and Metadata changes are processed
            console.log(`[Monitor] Ignoring unmapped action type: ${record.Action} - ${record.Display || 'No display'}`);
            // processed = false; // Don't count unmapped actions
          }

          if (processed) {
            changesProcessed++;
            changes.push({
              orgId,
              action: record.Action,
              display: record.Display || 'No description',
              type: changeType,
              timestamp: record.CreatedDate,
              user: record.CreatedBy?.Name || 'Unknown'
            });
          }
        } catch (error) {
          console.error(`[Monitor] Error processing change ${record.Id} (Action: ${record.Action}):`, error);
        }
      }
    } catch (error) {
      console.error(`[Monitor] Error processing org ${orgId}:`, error);
      throw error;
    }

    return { count: changesProcessed, changes };
  }

  /**
   * Check if audit record is a Flow change
   * Uses exact 2026 Salesforce Action codes (case-sensitive)
   */
  private isFlowChange(record: SetupAuditTrail): boolean {
    const action = record.Action;
    const flowActions = [
      'createdinteractiondefversion', 
      'activatedinteractiondefversion', 
      'deactivatedinteractiondefversion',
      'createdinteractiondefinition'
    ];
    return flowActions.includes(action);
  }

  /**
   * Check if audit record is a Permission change
   * Uses exact 2026 Salesforce Action codes (case-sensitive)
   */
  private isPermissionChange(record: SetupAuditTrail): boolean {
    const action = record.Action;
    const permissionActions = [
      'PermSetAssign',
      'PermSetUnassign',
      'PermSetCreate',
      'PermSetEnableUserPerm',
      'profile_entity_permissions'
    ];
    return permissionActions.includes(action);
  }

  /**
   * Check if audit record is an Object change
   * Uses exact 2026 Salesforce Action codes (case-sensitive)
   */
  private isObjectChange(record: SetupAuditTrail): boolean {
    const action = record.Action;
    const objectActions = [
      'CreatedCustomObject',
      'DeletedCustomObject'
    ];
    return objectActions.includes(action);
  }

  /**
   * Check if audit record is a Validation Rule change
   * Uses exact 2026 Salesforce Action codes (case-sensitive)
   */
  private isValidationChange(record: SetupAuditTrail): boolean {
    const action = record.Action;
    const validationActions = [
      'changedValidationFormula',    // Formula logic changed
      'changedValidationMessage',      // Error message changed
      'createdValidationRule',         // New validation rule created
      'changedValidationRule',         // Validation rule modified (general)
      'deletedValidationRule'          // Validation rule deleted
    ];
    return validationActions.includes(action);
  }

  /**
   * Check if audit record is a Formula Field change (not Validation Rule)
   * Uses exact 2026 Salesforce Action codes (case-sensitive)
   */
  private isFormulaFieldChange(record: SetupAuditTrail): boolean {
    const action = record.Action;
    const formulaFieldActions = [
      'createdCFFormula',        // Custom Field Formula creation
      'changedCFFormula',        // Custom Field Formula modification
      'deletedCFFormula'         // Custom Field Formula deletion
    ];
    return formulaFieldActions.includes(action);
  }

  /**
   * Check if audit record is a Metadata change (Page Layouts, Custom Fields, etc.)
   * Uses exact 2026 Salesforce Action codes (case-sensitive)
   * Excludes formula fields (handled separately)
   */
  private isMetadataChange(record: SetupAuditTrail): boolean {
    const action = record.Action;
    const metadataActions = [
      'accountlayout',           // Page Layout changes
      'createdCustomField',      // Custom Field creation (non-formula)
      'changedCustomField',      // Custom Field modification (non-formula)
      'deletedCustomField'       // Custom Field deletion
    ];
    return metadataActions.includes(action);
  }

  /**
   * Process Flow change
   * Uses Salesforce native integration (publishAuditToSalesforce) instead of webhook
   */
  private async processFlowChange(orgId: string, auditRecord: SetupAuditTrail, settings: OrgSettings): Promise<void> {
    try {
      // Extract flow name from Display field
      // Format examples: 
      // - "Created flow version #7 'Slack Messaging' for flow with Unique Name 'Slack_Messaging'"
      // - "Activated flow version #6 'Slack Messaging' for flow with Unique Name 'Slack_Messaging'"
      // - "Created flow with Name 'Slack Messaging' and Unique Name 'Slack_Messaging'"
      const display = auditRecord.Display || '';
      
      // Try to extract Unique Name (most reliable)
      let flowNameMatch = display.match(/Unique Name\s+["']([^"']+)["']/i);
      if (!flowNameMatch) {
        // Fallback: try to extract from "flow with Name" or "flow version #X"
        flowNameMatch = display.match(/flow[:\s]+(.+?)(?:\s+for flow|\s+with|$)/i) || 
                        display.match(/version[^"']*["']([^"']+)["']/i);
      }
      
      if (!flowNameMatch || !flowNameMatch[1]) {
        console.warn(`[Monitor] Could not extract flow name from: ${display}`);
        return;
      }

      const flowName = flowNameMatch[1].trim();

      // Get flow versions
      const versions = await this.salesforceService.getFlowVersions(orgId, flowName);

      // Check if this flow is used as a subflow by other flows
      const parentFlows = await this.salesforceService.findParentFlows(orgId, flowName);

      // Generate AI summary (includes parent flow context)
      const diff = await this.aiService.generateSummary(
        versions.previous,
        versions.current,
        flowName,
        settings,
        parentFlows.length > 0 ? parentFlows : undefined
      );

      // Determine risk level based on summary, security findings, and parent flows
      const hasCriticalFindings = diff.securityFindings && diff.securityFindings.length > 0 && 
        diff.securityFindings.some((f: string) => f.includes('🔴 CRITICAL') || f.includes('CRITICAL'));
      
      // Elevate risk if this is a subflow used by parent flows
      let baseRiskLevel = hasCriticalFindings ? 'High' : this.determineRiskLevel(diff.summary);
      if (parentFlows.length > 0 && baseRiskLevel === 'Low') {
        baseRiskLevel = 'Medium'; // Subflow changes always at least Medium risk
      }
      const riskLevel = baseRiskLevel;
      const riskEmoji = riskLevel === 'High' ? '🔴' : riskLevel === 'Medium' ? '🟡' : '🟢';

      // Parse the AI summary to extract sections (avoid duplication)
      const summaryLines = diff.summary.split('\n');
      let parsedSummary = diff.summary;
      let parsedChanges: string[] = [];
      let parsedSecurity: string[] = [];
      
      // Extract sections from AI response
      let inChanges = false;
      let inSecurity = false;
      
      for (const line of summaryLines) {
        if (line.trim().startsWith('SUMMARY:')) {
          inChanges = false;
          inSecurity = false;
          parsedSummary = line.replace(/^SUMMARY:\s*/i, '').trim();
          continue;
        }
        if (line.trim().startsWith('CHANGES:')) {
          inChanges = true;
          inSecurity = false;
          continue;
        }
        if (line.trim().startsWith('SECURITY & PERFORMANCE:') || line.trim().startsWith('SECURITY AND PERFORMANCE:')) {
          inChanges = false;
          inSecurity = true;
          const content = line.split(':').slice(1).join(':').trim();
          if (content) parsedSecurity.push(content);
          continue;
        }
        if (line.trim().startsWith('IMPACTS:')) {
          break;
        }
        
        if (inChanges && line.trim().startsWith('-')) {
          parsedChanges.push(line.trim().substring(1).trim());
        }
        if (inSecurity && line.trim()) {
          parsedSecurity.push(line.trim());
        }
      }

      // Use parsed sections if available, otherwise use extracted arrays
      const changesToShow = parsedChanges.length > 0 ? parsedChanges : diff.changes;
      const securityToShow = parsedSecurity.length > 0 ? parsedSecurity : (diff.securityFindings || []);

      // Build summary text for Slack (formatted for Salesforce Flow → Slack)
      // Slack uses single asterisk (*) for bold, underscore (_) for italic
      let summaryText = `🚨 *Flow Change Detected: ${flowName}*\n\n`;
      
      // Add parent flow warning if this is a subflow
      if (parentFlows.length > 0) {
        summaryText += `⚠️ *This Flow is a SUBFLOW used by ${parentFlows.length} parent Flow(s):*\n`;
        parentFlows.forEach(p => {
          summaryText += `  • *${p.flowApiName}*${p.label ? ` (${p.label})` : ''}\n`;
        });
        summaryText += `\n*Impact:* Changes to this subflow will affect all parent flows listed above.\n\n`;
      }
      
      summaryText += `*Summary:*\n${parsedSummary}\n\n`;
      
      // Only add Changes section if not already in summary
      if (changesToShow.length > 0 && !parsedSummary.includes('CHANGES:')) {
        summaryText += `*Changes:*\n${changesToShow.map(c => `• ${c}`).join('\n')}\n\n`;
      }
      
      // Only add Security & Performance if present and not already in summary
      if (securityToShow.length > 0 && !parsedSummary.includes('SECURITY & PERFORMANCE') && !parsedSummary.includes('SECURITY AND PERFORMANCE')) {
        summaryText += `*Security & Performance:*\n${securityToShow.join('\n')}\n\n`;
      }
      
      summaryText += `*Risk Level:* ${riskEmoji} ${riskLevel}\n` +
        `*Changed by:* ${auditRecord.CreatedBy.Name}\n` +
        `*Time:* ${new Date(auditRecord.CreatedDate).toLocaleString()}\n` +
        `*View in Salesforce:* ${settings.instanceUrl}/lightning/setup/Flows/home`;

      // Publish to Salesforce custom object (triggers Flow → Slack via native integration)
      await this.salesforceService.publishAuditToSalesforce(orgId, summaryText, flowName);

      console.log(`[Monitor] Published Flow change notification to Salesforce for: ${flowName}`);
    } catch (error) {
      console.error(`[Monitor] Error processing flow change:`, error);
      throw error;
    }
  }

  /**
   * Process Permission change
   * Uses Salesforce native integration (publishAuditToSalesforce) instead of webhook
   */
  private async processPermissionChange(orgId: string, auditRecord: SetupAuditTrail, settings: OrgSettings): Promise<void> {
    try {
      const display = auditRecord.Display || auditRecord.Action || 'Unknown Permission Change';
      
      // Build summary text for Slack (formatted for Salesforce Flow → Slack)
      const summaryText = `🔐 *Permission Change Detected*\n\n` +
        `*Change:* ${display}\n\n` +
        `*Changed by:* ${auditRecord.CreatedBy.Name}\n` +
        `*Time:* ${new Date(auditRecord.CreatedDate).toLocaleString()}\n` +
        `*Risk Level:* 🟡 Medium\n` +
        `*View in Salesforce:* ${settings.instanceUrl}/lightning/setup/Security/home`;

      // Publish to Salesforce custom object (triggers Flow → Slack via native integration)
      await this.salesforceService.publishAuditToSalesforce(orgId, summaryText, display);

      console.log(`[Monitor] Published Permission change notification to Salesforce for: ${display}`);
    } catch (error) {
      console.error(`[Monitor] Error processing permission change:`, error);
      throw error;
    }
  }

  /**
   * Process Object change
   * Uses Salesforce native integration (publishAuditToSalesforce) instead of webhook
   */
  private async processObjectChange(orgId: string, auditRecord: SetupAuditTrail, settings: OrgSettings): Promise<void> {
    try {
      const display = auditRecord.Display || auditRecord.Action || 'Unknown Object Change';
      
      // Build summary text for Slack (formatted for Salesforce Flow → Slack)
      const summaryText = `📊 *Object Change Detected*\n\n` +
        `*Change:* ${display}\n\n` +
        `*Changed by:* ${auditRecord.CreatedBy.Name}\n` +
        `*Time:* ${new Date(auditRecord.CreatedDate).toLocaleString()}\n` +
        `*Risk Level:* 🟡 Medium\n` +
        `*View in Salesforce:* ${settings.instanceUrl}/lightning/setup/ObjectManager/home`;

      // Publish to Salesforce custom object (triggers Flow → Slack via native integration)
      await this.salesforceService.publishAuditToSalesforce(orgId, summaryText, display);

      console.log(`[Monitor] Published Object change notification to Salesforce for: ${display}`);
    } catch (error) {
      console.error(`[Monitor] Error processing object change:`, error);
      throw error;
    }
  }

  /**
   * Process Validation Rule change
   * Gets validation rule ID, finds previous version, compares formulas, and explains diff in human language
   */
  private async processValidationChange(orgId: string, auditRecord: SetupAuditTrail, settings: OrgSettings): Promise<void> {
    const display = auditRecord.Display || '';
    
    try {
      // Extract validation rule name from Display field using regex
      // Format examples:
      // - "ValidationRule: RuleName"
      // - "Validation Rule: RuleName"
      // - "Changed validation rule Prevent_Invalid_Email"
      // - "Changed error message for Accounts validation "In_dustry_validation_rule" from ..."
      let ruleNameMatch = display.match(/(?:ValidationRule|Validation Rule):\s*(.+?)(?:\s|$)/i) ||
                         display.match(/validation rule\s+(.+?)(?:\s|$)/i) ||
                         display.match(/validation\s+["']([^"']+)["']/i) ||  // Handles: "validation "RuleName""
                         display.match(/rule\s+["']?([^"'\s]+)["']?/i);
      
      if (!ruleNameMatch || !ruleNameMatch[1]) {
        console.warn(`[Monitor] Could not extract validation rule name from: ${display}`);
        // Fallback: publish with raw display text
        await this.publishFallbackNotification(orgId, 'Validation Rule Change', display, auditRecord, settings);
        return;
      }

      const ruleName = ruleNameMatch[1].trim();
      const currentChangeTime = auditRecord.CreatedDate;

      try {
        // Get validation rule ID and current formula using Tooling API
        const metadata = await this.salesforceService.getValidationRuleMetadata(orgId, ruleName);
        
        if (!metadata || !metadata.errorConditionFormula) {
          console.warn(`[Monitor] Could not fetch validation rule metadata for: ${ruleName}`);
          // Fallback: publish with raw display text
          await this.publishFallbackNotification(orgId, `Validation Rule: ${ruleName}`, display, auditRecord, settings);
          return;
        }

        const validationRuleId = metadata.id;
        const currentFormula = metadata.errorConditionFormula;

        console.log(`[Monitor] Processing Validation Rule change: ${ruleName} (ID: ${validationRuleId})`);

        // Get previous and current versions for comparison
        const versions = await this.salesforceService.getValidationRuleVersions(
          orgId,
          ruleName,
          currentChangeTime
        );

        // Compare formulas and get AI explanation of the diff
        const diffExplanation = await this.aiService.compareValidationRuleFormulas(
          versions.previous,
          versions.current,
          ruleName,
          settings
        );

        // Build summary text for Slack (formatted for Salesforce Flow → Slack)
        let summaryText = `🔍 *Validation Rule Updated: ${ruleName}*\n\n`;
        
        if (versions.previous) {
          summaryText += `*Previous Formula:*\n\`\`\`${versions.previous}\`\`\`\n\n`;
        }
        
        summaryText += `*New Formula:*\n\`\`\`${currentFormula}\`\`\`\n\n` +
          `*AI Explanation of Changes:*\n${diffExplanation}\n\n` +
          `*Validation Rule ID:* ${validationRuleId}\n` +
          `*Changed by:* ${auditRecord.CreatedBy?.Name || 'Unknown'}\n` +
          `*Time:* ${new Date(auditRecord.CreatedDate).toLocaleString()}`;

        // Publish to Salesforce custom object (triggers Flow → Slack via native integration)
        await this.salesforceService.publishAuditToSalesforce(orgId, summaryText, ruleName);

        console.log(`[Monitor] Published Validation Rule change notification to Salesforce for: ${ruleName} (ID: ${validationRuleId})`);
      } catch (error) {
        console.error(`[Monitor] Error fetching Validation Rule metadata for ${ruleName}:`, error);
        // Fallback: publish with raw display text
        await this.publishFallbackNotification(orgId, `Validation Rule: ${ruleName}`, display, auditRecord, settings);
      }
    } catch (error) {
      console.error(`[Monitor] Error processing validation rule change:`, error);
      // Final fallback: publish with raw display text
      await this.publishFallbackNotification(orgId, 'Validation Rule Change', display, auditRecord, settings);
    }
  }

  /**
   * Extract object name from Section field
   * Examples: "Customize Accounts" -> "Account", "Customize Leads" -> "Lead"
   */
  private extractObjectNameFromSection(section: string): string | null {
    if (!section) return null;
    
    // Pattern: "Customize [ObjectName]" or "Customize [ObjectName]s"
    const match = section.match(/Customize\s+([A-Za-z0-9_]+)/i);
    if (match && match[1]) {
      let objectName = match[1];
      // Remove plural 's' if present (e.g., "Accounts" -> "Account")
      if (objectName.endsWith('s') && objectName.length > 1) {
        objectName = objectName.slice(0, -1);
      }
      return objectName;
    }
    
    return null;
  }

  /**
   * Process Formula Field change (separate from Validation Rules)
   * Fetches metadata via Tooling API and generates AI interpretation
   */
  private async processFormulaFieldChange(orgId: string, auditRecord: SetupAuditTrail, settings: OrgSettings): Promise<void> {
    const display = auditRecord.Display || '';
    const section = auditRecord.Section || '';
    
    try {
      // Extract field name from Display field
      // Format examples: 
      // - "Created custom formula field: Formula Test (Text)"
      // - "Changed custom field: Account.CustomField__c"
      // - "Formula Test"
      let fieldMatch = display.match(/(?:field|formula field):\s*(.+?)(?:\s*\(|$)/i) ||
                       display.match(/\.([A-Za-z0-9_]+__c)/) ||
                       display.match(/^([A-Za-z0-9_\s]+?)(?:\s*\(|$)/);
      
      if (!fieldMatch || !fieldMatch[1]) {
        console.warn(`[Monitor] Could not extract field name from: ${display}`);
        await this.publishFallbackNotification(orgId, 'Custom Field Change', display, auditRecord, settings);
        return;
      }

      const fieldName = fieldMatch[1].trim();
      
      // Extract object name from multiple sources (priority order):
      // 1. Display field if it contains Object.Field format
      // 2. Section field (e.g., "Customize Accounts" -> "Account")
      // 3. Fallback to "Unknown"
      let objectName = 'Unknown';
      
      // Try Display field first (e.g., "Account.CustomField__c")
      const objectMatch = display.match(/([A-Za-z0-9_]+)\.([A-Za-z0-9_]+)/);
      if (objectMatch && objectMatch[1]) {
        objectName = objectMatch[1];
      } else {
        // Try Section field (e.g., "Customize Accounts")
        const sectionObjectName = this.extractObjectNameFromSection(section);
        if (sectionObjectName) {
          objectName = sectionObjectName;
        } else {
          console.warn(`[Monitor] Could not determine object name from Display: "${display}" or Section: "${section}"`);
        }
      }

      try {
        // Get Formula Field metadata using Tooling API (separate from Validation Rules)
        const fieldMetadata = await this.salesforceService.getFormulaFieldMetadata(
          orgId,
          fieldName,
          objectName
        );

        if (!fieldMetadata) {
          console.warn(`[Monitor] Could not fetch Formula Field metadata for ${objectName}.${fieldName}`);
          await this.publishFallbackNotification(orgId, `Formula Field: ${fieldName}`, display, auditRecord, settings);
          return;
        }

        // Generate AI interpretation with type flag for Formula Field (calculation, not blocker)
        const interpretation = await this.aiService.interpretMetadataChange(
          fieldMetadata,
          'FormulaField',
          `${objectName}.${fieldName}`,
          settings
        );

        // Build summary text
        const summaryText = `🔢 *Formula Field Updated: ${objectName}.${fieldName}*\n\n` +
          `*Field Label:* ${fieldMetadata.label || 'N/A'}\n` +
          `*Field Type:* ${fieldMetadata.type || 'N/A'}\n` +
          (fieldMetadata.formula ? `*Formula:*\n\`\`\`${fieldMetadata.formula}\`\`\`\n\n` : '') +
          `*AI Interpretation:*\n${interpretation}\n\n` +
          `*Changed by:* ${auditRecord.CreatedBy?.Name || 'Unknown'}\n` +
          `*Time:* ${new Date(auditRecord.CreatedDate).toLocaleString()}`;

        await this.salesforceService.publishAuditToSalesforce(orgId, summaryText, `${objectName}.${fieldName}`);
        console.log(`[Monitor] Published Formula Field change notification for: ${objectName}.${fieldName}`);
      } catch (error) {
        console.error(`[Monitor] Error fetching Formula Field metadata:`, error);
        await this.publishFallbackNotification(orgId, `Formula Field: ${fieldName}`, display, auditRecord, settings);
      }
    } catch (error) {
      console.error(`[Monitor] Error processing formula field change:`, error);
      await this.publishFallbackNotification(orgId, 'Formula Field Change', display, auditRecord, settings);
    }
  }

  /**
   * Process Metadata change (Page Layouts, Custom Fields, etc.)
   * Uses Salesforce native integration (publishAuditToSalesforce) instead of webhook
   */
  private async processMetadataChange(orgId: string, auditRecord: SetupAuditTrail, settings: OrgSettings): Promise<void> {
    try {
      const display = auditRecord.Display || auditRecord.Action || 'Unknown Metadata Change';
      const action = auditRecord.Action;
      
      // Determine change type and icon based on action
      let changeType = 'Metadata Change';
      let icon = '📝';
      
      if (action === 'accountlayout' || action?.includes('layout')) {
        changeType = 'Page Layout Change';
        icon = '📄';
      } else if (action?.includes('CustomField')) {
        changeType = 'Custom Field Change';
        icon = '📋';
      }
      
      // Build summary text for Slack (formatted for Salesforce Flow → Slack)
      const summaryText = `${icon} *${changeType} Detected*\n\n` +
        `*Change:* ${display}\n\n` +
        `*Changed by:* ${auditRecord.CreatedBy?.Name || 'Unknown'}\n` +
        `*Time:* ${new Date(auditRecord.CreatedDate).toLocaleString()}\n` +
        `*Risk Level:* 🟡 Medium\n` +
        `*View in Salesforce:* ${settings.instanceUrl}/lightning/setup/ObjectManager/home`;

      // Publish to Salesforce custom object (triggers Flow → Slack via native integration)
      await this.salesforceService.publishAuditToSalesforce(orgId, summaryText, display);

      console.log(`[Monitor] Published ${changeType} notification to Salesforce for: ${display}`);
    } catch (error) {
      console.error(`[Monitor] Error processing metadata change:`, error);
      throw error;
    }
  }

  /**
   * Publish fallback notification when metadata cannot be fetched
   * Uses raw display text from audit trail
   */
  private async publishFallbackNotification(
    orgId: string,
    changeType: string,
    display: string,
    auditRecord: SetupAuditTrail,
    _settings: OrgSettings // Kept for API consistency, but not used in fallback
  ): Promise<void> {
    const summaryText = `📝 *${changeType} Detected*\n\n` +
      `*Change:* ${display}\n\n` +
      `*Note:* Full metadata could not be retrieved. This may indicate the item was deleted or is not accessible.\n\n` +
      `*Changed by:* ${auditRecord.CreatedBy?.Name || 'Unknown'}\n` +
      `*Time:* ${new Date(auditRecord.CreatedDate).toLocaleString()}`;

    await this.salesforceService.publishAuditToSalesforce(orgId, summaryText, changeType);
    console.log(`[Monitor] Published fallback notification for: ${changeType}`);
  }

  /**
   * Process unmapped actions by sending to LLM for interpretation
   * Handles actions that don't match any known category
   * 
   * DISABLED: This method was commented out because sending all unmapped actions to LLM
   * generated too many notifications. Only known action types (Flow, Permission, Object,
   * Validation Rule, Formula Field, Metadata) are now processed.
   * 
   * If you need to re-enable this:
   * 1. Uncomment the method call in processOrgChanges()
   * 2. Uncomment this method
   * 3. Uncomment interpretUnmappedAction() in aiService.ts
   */
  /*
  private async processUnmappedAction(
    orgId: string,
    auditRecord: SetupAuditTrail,
    settings: OrgSettings
  ): Promise<void> {
    try {
      const display = auditRecord.Display || auditRecord.Action || 'Unknown Change';
      const action = auditRecord.Action;
      
      // Send action and display to LLM for interpretation
      const interpretation = await this.aiService.interpretUnmappedAction(
        action,
        display,
        auditRecord.Section || 'Unknown Section',
        settings
      );

      // Build summary text
      const summaryText = `📋 *Unmapped Change Detected*\n\n` +
        `*Action:* ${action}\n` +
        `*Description:* ${display}\n` +
        `*Section:* ${auditRecord.Section || 'Unknown'}\n\n` +
        `*AI Interpretation:*\n${interpretation}\n\n` +
        `*Changed by:* ${auditRecord.CreatedBy?.Name || 'Unknown'}\n` +
        `*Time:* ${new Date(auditRecord.CreatedDate).toLocaleString()}\n` +
        `*Note:* This action type is not specifically mapped. Review manually if needed.`;

      await this.salesforceService.publishAuditToSalesforce(orgId, summaryText, action);
      console.log(`[Monitor] Published unmapped action notification for: ${action}`);
    } catch (error) {
      console.error(`[Monitor] Error processing unmapped action ${auditRecord.Action}:`, error);
      // Fallback to basic notification
      await this.publishFallbackNotification(
        orgId,
        `Unmapped Action: ${auditRecord.Action}`,
        auditRecord.Display || auditRecord.Action,
        auditRecord,
        settings
      );
    }
  }
  */

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
