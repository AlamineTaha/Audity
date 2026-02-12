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
  /** Startup Lookback: true after first poll; first poll uses 10-min window, subsequent use 60s */
  private hasCompletedFirstPoll = false;
  /** Poll lock: prevents duplicate processing when pollAuditTrail is called while already polling */
  private isPolling = false;

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
   * Get category for metadata type
   */
  private getCategoryForMetadataType(metadataType: string): 'Security' | 'Automation' | 'Schema' {
    switch (metadataType) {
      case 'FlowDefinition':
        return 'Automation';
      case 'ValidationRule':
      case 'CustomField':
        return 'Schema';
      case 'PermissionSet':
        return 'Security';
      default:
        return 'Schema';
    }
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
  async runChangeCheck(hours?: number, forceImmediate: boolean = false, debug: boolean = false): Promise<{ 
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
    if (this.isPolling) {
      console.log('[Monitor] Poll already in progress, skipping');
      return {
        success: true,
        changesFound: 0,
        errors: ['Poll already in progress'],
        changes: [],
      };
    }

    this.isPolling = true;
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
          const result = await this.processOrgChanges(orgId, hours, forceImmediate, debug);
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
    } finally {
      this.isPolling = false;
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

  private async processOrgChanges(orgId: string, hours?: number, forceImmediate: boolean = false, debug: boolean = false): Promise<{
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
        // Use hours-based query (e.g. manual trigger with ?hours=24)
        console.log(`[POLL] Org ${orgId} - Querying audit trail (last ${hours} hour(s))`);
        auditRecords = await this.salesforceService.queryAuditTrailByHours(orgId, hours);
      } else if (!this.hasCompletedFirstPoll) {
        // Startup Lookback: First execution uses 10-minute window to catch changes before server start
        console.log(`[POLL] Org ${orgId} - First poll: 10-minute startup lookback`);
        auditRecords = await this.salesforceService.queryAuditTrail(orgId, 10);
        this.hasCompletedFirstPoll = true;
      } else {
        // Snapshot window: exactly 300 seconds (5 min) when endpoint is triggered
        console.log(`[POLL] Org ${orgId} - Querying audit trail (last 300 seconds)`);
        auditRecords = await this.salesforceService.queryAuditTrailBySecondsFiltered(orgId, 300);
      }

      if (auditRecords.length === 0) {
        const timeWindow = hours ? `${hours} hour(s)` : (this.hasCompletedFirstPoll ? '300 seconds' : '10 minutes');
        console.log(`[POLL] Org ${orgId} - No audit records in last ${timeWindow}`);
        console.log(`[Monitor] Tip: Try using /api/v1/recent-changes?orgId=${orgId}&hours=24 to see all recent changes`);
        return { count: 0, changes: [] };
      }

      console.log(`[POLL] Org ${orgId} - Found ${auditRecords.length} record(s): ${auditRecords.map(r => `${r.Action}(${r.Id})`).join(', ')}`);

      // Get org settings for billing mode
      const settings = await this.authService.getOrgSettings(orgId);
      if (!settings) {
        throw new Error(`No settings found for orgId: ${orgId}`);
      }

      // Filter: skip self, optionally skip already-processed (unless debug=true)
      const recordsToProcess: SetupAuditTrail[] = [];
      for (const record of auditRecords) {
        if (!record.Id) continue;
        const display = (record.Display || '').toLowerCase();
        const action = (record.Action || '').toLowerCase();
        if (display.includes('auditdelta_event__c') || display.includes('slack_channel_mapping')) continue;
        if (action === 'setupentityobjectfieldupdated') continue; // Break self-healing loop
        if (!debug) {
          const alreadyProcessed = await this.authService.isAuditRecordProcessed(orgId, record.Id);
          if (alreadyProcessed) continue;
        }
        recordsToProcess.push(record);
      }

      if (debug) {
        console.log(`[DEBUG] Bypassing cache - processing ${recordsToProcess.length} record(s) without deduplication`);
      }

      // Snapshot aggregation: group by metadata component (Map<MetadataName, AuditRecord[]>)
      const { groups, ungrouped } = this.groupByMetadataKey(recordsToProcess);

      for (const [metadataKey, records] of groups) {
        const [metadataType] = metadataKey.split(':').concat(['']);
        const sorted = [...records].sort((a, b) => new Date(a.CreatedDate).getTime() - new Date(b.CreatedDate).getTime());
        const oldest = sorted[0];
        const newest = sorted[sorted.length - 1];

        try {
          if (metadataType === 'FlowDefinition') {
            await this.processFlowChangeGroupOldestNewest(orgId, oldest, newest, records, settings, forceImmediate);
          } else if (metadataType === 'ValidationRule') {
            await this.processValidationChangeGroup(orgId, oldest, newest, records, settings);
          } else if (metadataType === 'Permission') {
            for (const r of records) {
              await this.processPermissionChange(orgId, r, settings, forceImmediate);
            }
          } else if (metadataType === 'Object') {
            for (const r of records) {
              await this.processObjectChange(orgId, r, settings, forceImmediate);
            }
          } else if (metadataType === 'FormulaField' || metadataType === 'Metadata') {
            for (const r of records) {
              if (this.isFormulaFieldChange(r)) {
                await this.processFormulaFieldChange(orgId, r, settings, forceImmediate);
              } else {
                await this.processMetadataChange(orgId, r, settings, forceImmediate);
              }
            }
          } else {
            for (const r of records) {
              if (this.isFormulaFieldChange(r)) {
                await this.processFormulaFieldChange(orgId, r, settings, forceImmediate);
              } else if (this.isMetadataChange(r)) {
                await this.processMetadataChange(orgId, r, settings, forceImmediate);
              }
            }
          }

          for (const r of records) {
            if (!debug) await this.authService.markAuditRecordProcessed(orgId, r.Id);
            changesProcessed++;
            changes.push({
              orgId,
              action: r.Action,
              display: r.Display || 'No description',
              type: this.getChangeType(r),
              timestamp: r.CreatedDate,
              user: r.CreatedBy?.Name || 'Unknown'
            });
            console.log(`[PROCESSED] Org ${orgId} SetupAuditTrail.Id=${r.Id} | Op=${this.getChangeType(r)} | Action=${r.Action} | Section=${r.Section || '-'} | Display=${(r.Display || '')?.substring(0, 60)}`);
          }
        } catch (error) {
          console.error(`[Monitor] Error processing group ${metadataKey}:`, error);
        }
      }

      // Process records that couldn't be grouped (no metadata key)
      for (const record of ungrouped) {
        try {
          const changeType = this.getChangeType(record);
          let processed = false;

          if (this.isPermissionChange(record)) {
            await this.processPermissionChange(orgId, record, settings, forceImmediate);
            processed = true;
          } else if (this.isObjectChange(record)) {
            await this.processObjectChange(orgId, record, settings, forceImmediate);
            processed = true;
          } else if (this.isValidationChange(record)) {
            await this.processValidationChange(orgId, record, settings, forceImmediate);
            processed = true;
          } else if (this.isFormulaFieldChange(record)) {
            await this.processFormulaFieldChange(orgId, record, settings, forceImmediate);
            processed = true;
          } else if (this.isMetadataChange(record)) {
            await this.processMetadataChange(orgId, record, settings, forceImmediate);
            processed = true;
          } else {
            // Unmapped actions are now ignored - only process known action types
            // Previously: We sent unmapped actions to LLM for interpretation
            // This was disabled because it generated too many notifications
            // Only Flow, Permission, Object, Validation Rule, Formula Field, and Metadata changes are processed
            console.log(`[SKIP_UNMAPPED] Org ${orgId} SetupAuditTrail.Id=${record.Id} | Action=${record.Action} | Section=${record.Section || '-'} | Display=${(record.Display || '')?.substring(0, 50)}`);
            // processed = false; // Don't count unmapped actions
          }

          if (processed) {
            if (!debug) await this.authService.markAuditRecordProcessed(orgId, record.Id);
            const op = this.getChangeType(record);
            console.log(`[PROCESSED] Org ${orgId} SetupAuditTrail.Id=${record.Id} | Op=${op} | Action=${record.Action} | Section=${record.Section || '-'} | Display=${(record.Display || '')?.substring(0, 60)}`);
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
   * Extract metadata key for grouping: "metadataType:metadataName"
   * Returns null if record cannot be grouped (unmapped action)
   */
  private getMetadataKey(record: SetupAuditTrail): string | null {
    const display = record.Display || '';
    const section = record.Section || '';

    if (this.isFlowChange(record)) {
      const name = this.extractFlowName(display);
      return name ? `FlowDefinition:${name}` : null;
    }
    if (this.isValidationChange(record)) {
      const name = this.extractValidationRuleName(display);
      return name ? `ValidationRule:${name}` : null;
    }
    if (this.isPermissionChange(record)) {
      const name = this.extractPermissionName(display) || display?.substring(0, 80) || record.Action;
      return `Permission:${name}`;
    }
    if (this.isObjectChange(record)) {
      const name = this.extractObjectName(display, section) || display?.substring(0, 60) || record.Action;
      return `Object:${name}`;
    }
    if (this.isFormulaFieldChange(record)) {
      const name = this.extractFieldName(display, section) || display?.substring(0, 60) || record.Action;
      return `FormulaField:${name}`;
    }
    if (this.isMetadataChange(record)) {
      const name = this.extractFieldName(display, section) || display?.substring(0, 60) || record.Action;
      return `Metadata:${name}`;
    }
    return null;
  }

  private extractValidationRuleName(display: string): string | null {
    const m = display.match(/(?:ValidationRule|Validation Rule):\s*(.+?)(?:\s|$)/i) ||
      display.match(/validation rule\s+(.+?)(?:\s|$)/i) ||
      display.match(/validation\s+["']([^"']+)["']/i) ||
      display.match(/rule\s+["']?([^"'\s]+)["']?/i);
    return m?.[1]?.trim() || null;
  }

  private extractPermissionName(display: string): string | null {
    const m = display.match(/(?:Permission Set|Profile):\s*(.+?)(?:\s|$)/i) ||
      display.match(/assigned\s+(.+?)\s+to/i);
    return m?.[1]?.trim() || null;
  }

  private extractObjectName(display: string, section: string): string | null {
    const secMatch = section.match(/Customize\s+([A-Za-z0-9_]+)/i);
    if (secMatch) return secMatch[1].replace(/s$/, '') || null;
    const dispMatch = display.match(/(?:object|Object):\s*([A-Za-z0-9_]+)/i);
    return dispMatch?.[1]?.trim() || null;
  }

  private extractFieldName(display: string, _section: string): string | null {
    const m = display.match(/(?:field|formula field):\s*(.+?)(?:\s*\(|$)/i) ||
      display.match(/\.([A-Za-z0-9_]+__c)/) ||
      display.match(/"([^"]+)"(?:\s+field|$)/i);
    return m?.[1]?.trim() || null;
  }

  /**
   * Group records by metadata component key
   * Returns groups (Map) and ungrouped records (no extractable key)
   */
  private groupByMetadataKey(records: SetupAuditTrail[]): { groups: Map<string, SetupAuditTrail[]>; ungrouped: SetupAuditTrail[] } {
    const groups = new Map<string, SetupAuditTrail[]>();
    const ungrouped: SetupAuditTrail[] = [];
    for (const record of records) {
      const key = this.getMetadataKey(record);
      if (!key) {
        ungrouped.push(record);
        continue;
      }
      const list = groups.get(key) || [];
      list.push(record);
      groups.set(key, list);
    }
    return { groups, ungrouped };
  }

  /**
   * Extract flow name from Display field
   */
  private extractFlowName(display: string): string | null {
    const flowNameMatch = display.match(/Unique Name\s+["']([^"']+)["']/i) ||
      display.match(/flow[:\s]+(.+?)(?:\s+for flow|\s+with|$)/i) ||
      display.match(/version[^"']*["']([^"']+)["']/i);
    return flowNameMatch?.[1]?.trim() || null;
  }

  /**
   * Extract version number from Display (e.g. "version #7" -> 7)
   */
  private extractVersionFromDisplay(display: string): number | undefined {
    const m = display.match(/version\s*#?\s*(\d+)/i);
    return m ? parseInt(m[1], 10) : undefined;
  }

  /**
   * Process Flow activation: N vs N-1 delta, threaded ledger, version check
   */
  private async processFlowChangeGroupOldestNewest(
    orgId: string,
    oldest: SetupAuditTrail,
    newest: SetupAuditTrail,
    allRecords: SetupAuditTrail[],
    settings: OrgSettings,
    _forceImmediate: boolean
  ): Promise<void> {
    const flowName = this.extractFlowName(oldest.Display || newest.Display || '');
    if (!flowName) return;

    const activatedVersion = this.extractVersionFromDisplay(newest.Display || '');
    const maxVersion = await this.salesforceService.getFlowMaxVersion(orgId, flowName);

    if (activatedVersion !== undefined && activatedVersion !== maxVersion) {
      console.log(`[Monitor] Skipping Flow ${flowName}: activated v${activatedVersion} is not latest (v${maxVersion})`);
      return;
    }

    const delta = await this.salesforceService.getFlowDelta(orgId, flowName);
    if (!delta) {
      console.warn(`[Monitor] No flow delta for ${flowName}`);
      return;
    }

    const parentFlows = await this.salesforceService.findParentFlows(orgId, flowName);
    const diff = await this.aiService.generateSummary(
      delta.previous,
      delta.current,
      flowName,
      settings,
      parentFlows.length > 0 ? parentFlows : undefined
    );

    const mainMessage = allRecords.length === 1
      ? this.buildSingleFlowMessage(flowName, diff.summary, newest, parentFlows, settings)
      : `🔔 *Flow activation: "${flowName}"*\n\n` +
        `*Version:* v${delta.previousVersion} → v${delta.currentVersion}\n` +
        `*Summary:*\n${diff.summary}\n\n` +
        `*View in Salesforce:* ${settings.instanceUrl}/lightning/setup/Flows/home`;

    const threadTs = await this.authService.getFlowThreadTs(orgId, flowName);
    const category = this.getCategoryForMetadataType('FlowDefinition');
    await this.salesforceService.publishAuditToSalesforce(orgId, mainMessage, flowName, category, threadTs ?? undefined);
    console.log(`[Monitor] Published Flow activation for ${flowName}${threadTs ? ' (threaded)' : ' (new thread)'}`);
  }

  /**
   * Process validation group: compare OLDEST vs NEWEST formula only
   */
  private async processValidationChangeGroup(
    orgId: string,
    oldest: SetupAuditTrail,
    newest: SetupAuditTrail,
    allRecords: SetupAuditTrail[],
    settings: OrgSettings
  ): Promise<void> {
    const ruleName = this.extractValidationRuleName(oldest.Display || newest.Display || '');
    if (!ruleName) {
      for (const r of allRecords) {
        await this.processValidationChange(orgId, r, settings, false);
      }
      return;
    }

    const alreadySent = await this.authService.isValidationRuleRecentlyProcessed(orgId, ruleName);
    if (alreadySent) {
      console.log(`[SKIP_VALIDATION_DUPE] Org ${orgId} Rule=${ruleName} - already sent`);
      return;
    }

    const versions = await this.salesforceService.getValidationRuleVersions(orgId, ruleName, newest.CreatedDate);
    const diffExplanation = await this.aiService.compareValidationRuleFormulas(
      versions.previous,
      versions.current,
      ruleName,
      settings
    );

    const summaryText = `🔍 *Validation Rule (snapshot): ${ruleName}*\n\n` +
      (versions.previous ? `*Previous:*\n\`\`\`${versions.previous}\`\`\`\n\n` : '') +
      `*Current:*\n\`\`\`${versions.current}\`\`\`\n\n` +
      `*AI Explanation:*\n${diffExplanation}\n\n` +
      `*Records in window:* ${allRecords.length} (oldest→newest only)\n` +
      `*Changed by:* ${newest.CreatedBy?.Name || 'Unknown'}\n` +
      `*Time:* ${new Date(newest.CreatedDate).toLocaleString()}`;

    const category = this.getCategoryForMetadataType('ValidationRule');
    await this.salesforceService.publishAuditToSalesforce(orgId, summaryText, ruleName, category);
    await this.authService.markValidationRuleProcessed(orgId, ruleName);
    console.log(`[Monitor] Published Validation Rule snapshot for ${ruleName}`);
  }

  /**
   * Build message for single flow change
   */
  private buildSingleFlowMessage(
    flowName: string,
    summary: string,
    auditRecord: SetupAuditTrail,
    parentFlows: Array<{ flowApiName: string; label?: string }>,
    settings: OrgSettings
  ): string {
    const riskLevel = this.determineRiskLevel(summary);
    const riskEmoji = riskLevel === 'High' ? '🔴' : riskLevel === 'Medium' ? '🟡' : '🟢';
    let result = `🚨 *Flow Change Detected: ${flowName}*\n\n`;
    if (parentFlows.length > 0) {
      result += `⚠️ *This Flow is a SUBFLOW used by ${parentFlows.length} parent Flow(s):*\n`;
      parentFlows.forEach(p => { result += `  • *${p.flowApiName}*${p.label ? ` (${p.label})` : ''}\n`; });
      result += `\n*Impact:* Changes to this subflow will affect all parent flows listed above.\n\n`;
    }
    result += `*Summary:*\n${summary}\n\n`;
    result += `*Risk Level:* ${riskEmoji} ${riskLevel}\n` +
      `*Changed by:* ${auditRecord.CreatedBy?.Name || 'Unknown'}\n` +
      `*Time:* ${new Date(auditRecord.CreatedDate).toLocaleString()}\n` +
      `*View in Salesforce:* ${settings.instanceUrl}/lightning/setup/Flows/home`;
    return result;
  }

  /**
   * Check if audit record is a Flow ACTIVATION (Tooling API only)
   * Only proceed for activation - immediate reaction, no waiting room
   */
  private isFlowChange(record: SetupAuditTrail): boolean {
    const action = (record.Action || '').toLowerCase();
    return action === 'activatedinteractiondefversion';
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
   * Case-insensitive to handle Salesforce API variations
   */
  private isValidationChange(record: SetupAuditTrail): boolean {
    const action = (record.Action || '').toLowerCase();
    const validationActions = [
      'changedvalidationformula',
      'newValidation',
      'changedvalidationmessage',
      'createdvalidationrule',
      'changedvalidationrule',
      'deletedvalidationrule'
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
   * Process Permission change
   * Uses Salesforce native integration (publishAuditToSalesforce) instead of webhook
   */
  private async processPermissionChange(orgId: string, auditRecord: SetupAuditTrail, settings: OrgSettings, _forceImmediate: boolean = false): Promise<void> {
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
      const category = this.getCategoryForMetadataType('PermissionSet');
      await this.salesforceService.publishAuditToSalesforce(orgId, summaryText, display, category);

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
  private async processObjectChange(orgId: string, auditRecord: SetupAuditTrail, settings: OrgSettings, _forceImmediate: boolean = false): Promise<void> {
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
      const category = 'Schema';
      await this.salesforceService.publishAuditToSalesforce(orgId, summaryText, display, category);

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
  private async processValidationChange(orgId: string, auditRecord: SetupAuditTrail, settings: OrgSettings, _forceImmediate: boolean = false): Promise<void> {
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

      // Deduplication: SF creates multiple SetupAuditTrail records per validation change (formula, message, etc.)
      // Only send one Slack message per rule per 5 min
      const alreadySentForRule = await this.authService.isValidationRuleRecentlyProcessed(orgId, ruleName);
      if (alreadySentForRule) {
        console.log(`[SKIP_VALIDATION_DUPE] Org ${orgId} Rule=${ruleName} | Action=${auditRecord.Action} - already sent Slack for this rule`);
        return;
      }
      const currentChangeTime = auditRecord.CreatedDate;

      try {
        // Get validation rule ID and current formula using Tooling API
        const metadata = await this.salesforceService.getValidationRuleMetadata(orgId, ruleName);
        
        if (!metadata || !metadata.errorConditionFormula) {
          console.warn(`[Monitor] Could not fetch validation rule metadata for: ${ruleName}`);
          await this.publishFallbackNotification(orgId, `Validation Rule: ${ruleName}`, display, auditRecord, settings);
          await this.authService.markValidationRuleProcessed(orgId, ruleName);
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
        const category = this.getCategoryForMetadataType('ValidationRule');
        const recordId = await this.salesforceService.publishAuditToSalesforce(orgId, summaryText, ruleName, category);

        await this.authService.markValidationRuleProcessed(orgId, ruleName);
        console.log(`[Monitor] Created AuditDelta_Event__c ${recordId} for Validation Rule: ${ruleName}`);
      } catch (error) {
        console.error(`[Monitor] Error fetching Validation Rule metadata for ${ruleName}:`, error);
        await this.publishFallbackNotification(orgId, `Validation Rule: ${ruleName}`, display, auditRecord, settings);
        await this.authService.markValidationRuleProcessed(orgId, ruleName);
      }
    } catch (error) {
      console.error(`[Monitor] Error processing validation rule change:`, error);
      // Only mark if we extracted ruleName (avoid double-processing fallback)
      const ruleNameMatch = display.match(/(?:ValidationRule|Validation Rule):\s*(.+?)(?:\s|$)/i) ||
        display.match(/validation rule\s+(.+?)(?:\s|$)/i) ||
        display.match(/validation\s+["']([^"']+)["']/i);
      if (ruleNameMatch?.[1]) {
        await this.authService.markValidationRuleProcessed(orgId, ruleNameMatch[1].trim());
      }
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
  private async processFormulaFieldChange(orgId: string, auditRecord: SetupAuditTrail, settings: OrgSettings, _forceImmediate: boolean = false): Promise<void> {
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

        const category = this.getCategoryForMetadataType('CustomField');
        await this.salesforceService.publishAuditToSalesforce(orgId, summaryText, `${objectName}.${fieldName}`, category);
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
  private async processMetadataChange(orgId: string, auditRecord: SetupAuditTrail, settings: OrgSettings, _forceImmediate: boolean = false): Promise<void> {
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
      const category = 'Schema';
      await this.salesforceService.publishAuditToSalesforce(orgId, summaryText, display, category);

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

    const category = 'Schema';
    await this.salesforceService.publishAuditToSalesforce(orgId, summaryText, changeType, category);
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
