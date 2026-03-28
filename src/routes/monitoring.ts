/**
 * Monitoring Routes
 * REST API endpoints for proactive monitoring and manual triggers.
 *
 * Protected routes receive tenant context via the tenantAuth middleware.
 * The orgId is resolved from the X-API-Key header — never from request body/query.
 */

import { Router, Request, Response } from 'express';
import { MonitorService } from '../services/monitorService';
import { SalesforceService } from '../services/salesforceService';
import { AIService } from '../services/aiService';
import { SalesforceAuthService } from '../services/authService';
import { AuthenticatedRequest } from '../types';

const router = Router();

let monitorService: MonitorService | null = null;

function getMonitorService(): MonitorService {
  if (!monitorService) {
    const authService = new SalesforceAuthService();
    const salesforceService = new SalesforceService(authService);
    const aiService = new AIService();
    monitorService = new MonitorService(
      salesforceService,
      aiService,
      authService,
      10
    );
  }
  return monitorService;
}

export async function ensureWaitingRoomStarted(): Promise<void> {
  getMonitorService();
}

/**
 * Safe Slack invite — no org context needed, just channelId and userIds
 */
router.post('/slack-invite', async (req: Request, res: Response) => {
  try {
    const channelId = req.query.channelId ?? req.body.channelId;
    const userIds = req.query.userIds ?? req.body.userIds;
    if (!channelId) {
      return res.status(400).json({ success: false, error: 'channelId is required' });
    }
    let ids: string[];
    if (Array.isArray(userIds)) {
      ids = userIds;
    } else if (typeof userIds === 'string') {
      ids = userIds.split(',').map((s) => s.trim()).filter(Boolean);
    } else {
      ids = [];
    }
    const slackService = new (await import('../services/slackService')).SlackService();
    await slackService.inviteUsersSafely(channelId, ids);
    return res.json({ success: true });
  } catch (error) {
    console.error('[slack-invite] Error:', error);
    return res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * Callback for Salesforce Flow to store Slack thread_ts after posting.
 * Uses tenant context to resolve orgId.
 */
router.post('/slack-thread-callback', async (req: Request, res: Response) => {
  try {
    const { tenant } = req as AuthenticatedRequest;
    const orgId = tenant.orgId;
    const flowDeveloperName = req.query.flowDeveloperName ?? req.body.flowDeveloperName;
    const threadTs = req.query.threadTs ?? req.body.threadTs;

    if (!flowDeveloperName || !threadTs) {
      return res.status(400).json({
        success: false,
        error: 'flowDeveloperName and threadTs are required',
      });
    }

    const authService = new SalesforceAuthService();
    await authService.setFlowThreadTs(orgId, flowDeveloperName, threadTs);
    console.log(`[Slack] Stored thread_ts for ${orgId}:${flowDeveloperName}`);
    return res.json({ success: true });
  } catch (error) {
    console.error('[Slack] Thread callback error:', error);
    return res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * Clear audit_processed Redis cache (for re-testing).
 * No org context needed — clears all keys.
 */
router.post('/clear-audit-cache', async (_req: Request, res: Response) => {
  try {
    const authService = new SalesforceAuthService();
    await authService.connect();
    const count = await authService.cleanupAuditProcessedKeys();
    return res.json({
      success: true,
      message: `Cleared ${count} audit_processed key(s). You can re-test now.`,
      keysCleared: count,
    });
  } catch (error) {
    console.error('[clear-audit-cache] Error:', error);
    return res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * @swagger
 * /api/v1/trigger-check:
 *   post:
 *     summary: Force Immediate Change Check
 *     description: Manually triggers the polling engine to check all registered orgs for changes.
 *     tags:
 *       - Monitoring
 *     security: []
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               hours:
 *                 type: integer
 *               debug:
 *                 type: boolean
 *               forceImmediate:
 *                 type: boolean
 */
router.post('/trigger-check', async (req: Request, res: Response) => {
  try {
    const hours = req.query.hours ?? req.body.hours;
    const debug = req.query.debug ?? req.body.debug;
    const hoursNum = hours ? parseInt(String(hours), 10) : undefined;

    if (hoursNum !== undefined && (isNaN(hoursNum) || hoursNum < 1)) {
      return res.status(400).json({
        success: false,
        message: 'hours must be a positive integer',
        changesFound: 0,
        errors: ['Invalid hours parameter'],
      });
    }

    const service = getMonitorService();
    const forceImmediate =
      String(req.query.forceImmediate ?? req.body.forceImmediate ?? '') === 'true' ||
      String(req.query.immediate ?? req.body.immediate ?? '') === 'true';
    const debugMode = String(debug) === 'true';
    const result = await service.runChangeCheck(hoursNum, forceImmediate, debugMode);

    const timeWindow = hoursNum ? `${hoursNum} hour(s)` : '300 seconds';
    const message = result.success
      ? `Manual check completed (${timeWindow}). Found ${result.changesFound} change(s).`
      : 'Manual check completed with errors.';

    let displayText = message;
    if (result.changesFound > 0 && result.changes?.length) {
      const summaryLines = result.changes.slice(0, 10).map((c: any) =>
        `- ${c.action}: ${c.display || 'No details'} (by ${c.user || 'Unknown'})`
      );
      displayText += '\n\n' + summaryLines.join('\n');
      if (result.changesFound > 10) {
        displayText += `\n... and ${result.changesFound - 10} more change(s).`;
      }
    }
    if (result.errors?.length) {
      displayText += '\n\nErrors: ' + result.errors.join(', ');
    }

    return res.json({
      success: result.success,
      displayText,
      message,
      changesFound: result.changesFound,
      errors: result.errors,
      timeWindow: hoursNum ? `${hoursNum} hours` : '300 seconds',
      debug: debugMode,
      changes: result.changes || [],
    });
  } catch (error) {
    console.error('Error in trigger-check endpoint:', error);
    const errorMessage = error instanceof Error ? error.message : 'Internal server error';
    return res.status(500).json({
      success: false,
      message: errorMessage,
      changesFound: 0,
      errors: [errorMessage],
    });
  }
});

/**
 * @swagger
 * /api/v1/recent-changes:
 *   get:
 *     summary: Get Recent Org Activity
 *     description: Retrieves metadata changes from the Audit Trail with AI-powered explanations.
 *     tags:
 *       - Monitoring
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: query
 *         name: hours
 *         required: false
 *         schema:
 *           type: integer
 *           default: 24
 */
router.get('/recent-changes', async (req: Request, res: Response) => {
  try {
    const { tenant } = req as AuthenticatedRequest;
    const orgId = tenant.orgId;
    const { hours } = req.query;

    console.log(`[Recent Changes] Processing request - orgId: ${orgId}, hours: ${hours}`);

    const hoursNum = hours ? parseInt(hours as string, 10) : 24;
    if (isNaN(hoursNum) || hoursNum < 1) {
      return res.status(400).json({ error: 'hours must be a positive integer' });
    }

    const authService = new SalesforceAuthService();
    const salesforceService = new SalesforceService(authService);
    const aiService = new AIService();

    const settings = await authService.getOrgSettings(orgId);
    if (!settings) {
      return res.status(404).json({ error: `Organization ${orgId} not found or not configured` });
    }

    const auditRecords = await salesforceService.queryAuditTrailByHours(orgId, hoursNum);
    console.log(`[Recent Changes] Found ${auditRecords.length} audit record(s)`);

    const isValidationAction = (action: string): boolean =>
      ['changedValidationFormula', 'changedValidationMessage', 'newValidation',
       'createdValidationRule', 'changedValidationRule', 'deletedValidationRule'].includes(action);

    const isFormulaFieldAction = (action: string): boolean =>
      ['createdCFFormula', 'changedCFFormula', 'deletedCFFormula'].includes(action);

    const extractValidationRuleName = (display: string): string | null => {
      const patterns = [
        /validation\s+["']([^"']+)["']/i,
        /"([^"]+)"(?:\s+validation|$)/i,
        /(?:ValidationRule|Validation Rule):\s*(.+?)(?:\s|$)/i,
        /validation rule\s+(.+?)(?:\s|$)/i,
        /rule\s+["']?([^"'\s]+)["']?/i,
      ];
      for (const pattern of patterns) {
        const match = display.match(pattern);
        if (match?.[1]) return match[1].replace(/^["']+|["']+$/g, '').trim();
      }
      return null;
    };

    const extractObjectNameFromSection = (section: string): string | null => {
      if (!section) return null;
      const match = section.match(/Customize\s+([A-Za-z0-9_]+)/i);
      if (match?.[1]) {
        let objectName = match[1];
        if (objectName.endsWith('s') && objectName.length > 1) {
          objectName = objectName.slice(0, -1);
        }
        return objectName;
      }
      return null;
    };

    const extractFieldName = (display: string): string | null => {
      const patterns = [
        /(?:field|formula field):\s*(.+?)(?:\s*\(|$)/i,
        /\.([A-Za-z0-9_]+__c)/,
        /^([A-Za-z0-9_\s]+?)(?:\s*\(|$)/,
        /"([^"]+)"(?:\s+field|$)/i,
      ];
      for (const pattern of patterns) {
        const match = display.match(pattern);
        if (match?.[1]) return match[1].trim();
      }
      return null;
    };

    const CONCURRENCY = 3;
    const PER_RECORD_TIMEOUT_MS = 15_000;
    const changes: any[] = [];

    const withTimeout = <T>(promise: Promise<T>, ms: number): Promise<T | null> =>
      Promise.race([
        promise,
        new Promise<null>((resolve) => setTimeout(() => resolve(null), ms)),
      ]);

    for (let i = 0; i < auditRecords.length; i += CONCURRENCY) {
      const batch = auditRecords.slice(i, i + CONCURRENCY);
      const batchResults = await Promise.all(
        batch.map(async (record) => {
          const change: any = {
            action: record.Action,
            user: record.CreatedBy.Name,
            section: record.Section,
            timestamp: record.CreatedDate,
            display: record.Display,
            id: record.Id,
          };

          try {
            if (isValidationAction(record.Action)) {
              const ruleName = extractValidationRuleName(record.Display || '');
              if (ruleName) {
                const enriched = await withTimeout(
                  (async () => {
                    const validationMetadata = await salesforceService.getValidationRuleMetadata(orgId, ruleName);
                    if (validationMetadata) {
                      const metadata = {
                        errorConditionFormula: validationMetadata.errorConditionFormula,
                        id: validationMetadata.id,
                      };
                      return {
                        explanation: await aiService.interpretMetadataChange(metadata, 'ValidationRule', ruleName, settings),
                        metadataName: ruleName,
                        metadataType: 'ValidationRule',
                      };
                    }
                    return null;
                  })(),
                  PER_RECORD_TIMEOUT_MS
                );
                if (enriched) Object.assign(change, enriched);
              }
            } else if (isFormulaFieldAction(record.Action)) {
              const fieldName = extractFieldName(record.Display || '');
              const objectName = extractObjectNameFromSection(record.Section || '') ||
                (record.Display?.match(/([A-Za-z0-9_]+)\.([A-Za-z0-9_]+)/)?.[1]) ||
                'Unknown';

              if (fieldName && objectName !== 'Unknown') {
                const enriched = await withTimeout(
                  (async () => {
                    const formulaMetadata = await salesforceService.getFormulaFieldMetadata(orgId, fieldName, objectName);
                    if (formulaMetadata) {
                      return {
                        explanation: await aiService.interpretMetadataChange(formulaMetadata, 'FormulaField', `${objectName}.${fieldName}`, settings),
                        metadataName: `${objectName}.${fieldName}`,
                        metadataType: 'FormulaField',
                      };
                    }
                    return null;
                  })(),
                  PER_RECORD_TIMEOUT_MS
                );
                if (enriched) Object.assign(change, enriched);
              }
            }
          } catch (error) {
            console.warn(`[Recent Changes] Error enriching ${record.Action}:`, error instanceof Error ? error.message : error);
          }

          return change;
        })
      );
      changes.push(...batchResults);
    }

    console.log(`[Recent Changes] Finished processing ${changes.length} records`);

    let displayText = `${changes.length} change(s) found in the last ${hoursNum} hour(s).\n`;
    if (changes.length > 0) {
      const grouped: Record<string, any[]> = {};
      for (const c of changes) {
        const key = c.user || 'Unknown';
        if (!grouped[key]) grouped[key] = [];
        grouped[key].push(c);
      }
      for (const [user, userChanges] of Object.entries(grouped)) {
        displayText += `\n${user} (${userChanges.length} change(s)):\n`;
        for (const c of userChanges.slice(0, 5)) {
          displayText += `  - ${c.action}: ${c.display || 'No details'}`;
          if (c.explanation) displayText += `\n    ${c.explanation.split('\n')[0]}`;
          displayText += '\n';
        }
        if (userChanges.length > 5) {
          displayText += `  ... and ${userChanges.length - 5} more.\n`;
        }
      }
    } else {
      displayText += 'No changes detected in this time window.';
    }

    return res.json({
      success: true,
      displayText,
      count: changes.length,
      changes,
    });
  } catch (error) {
    console.error('[Recent Changes] Error:', error);
    const errorMessage = error instanceof Error ? error.message : 'Internal server error';
    return res.status(500).json({ error: errorMessage });
  }
});

/**
 * @swagger
 * /api/v1/analyze-permission:
 *   post:
 *     summary: Analyze Permission Set Security
 *     description: >
 *       Fetches a Permission Set (or Profile) by name and performs an AI-powered
 *       security audit. Returns all object access, system permissions, risks,
 *       and best-practice recommendations — similar to the validation-rule and
 *       flow analysis endpoints.
 *     tags:
 *       - Security
 *     security:
 *       - ApiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - permissionSetName
 *             properties:
 *               permissionSetName:
 *                 type: string
 *                 description: API Name or Label of the Permission Set (e.g. "Sales_User", "System Administrator")
 *                 example: Sales_User
 *     responses:
 *       200:
 *         description: AI-powered security analysis of the Permission Set
 *       400:
 *         description: Missing permissionSetName
 *       404:
 *         description: Permission Set not found
 */
router.post('/analyze-permission', async (req: Request, res: Response) => {
  try {
    const { tenant } = req as AuthenticatedRequest;
    const orgId = tenant.orgId;
    const permissionSetName = req.query.permissionSetName ?? req.body?.permissionSetName;

    if (!permissionSetName) {
      return res.status(400).json({
        error: 'permissionSetName is required',
        example: { permissionSetName: 'Sales_User' },
      });
    }

    const authService = new SalesforceAuthService();
    const salesforceService = new SalesforceService(authService);

    console.log(`[Analyze Permission] Fetching permission set: "${permissionSetName}"`);
    const psData = await salesforceService.getPermissionSetForAudit(orgId, String(permissionSetName));
    console.log(`[Analyze Permission] Found "${psData.label}" with ${psData.objectPermissions.length} object permissions and ${psData.systemPermissions.length} system permissions`);

    const settings = await authService.getOrgSettings(orgId);
    if (!settings) {
      return res.status(500).json({ error: 'Could not load org settings for AI analysis' });
    }

    const aiService = new AIService();
    const analysis = await aiService.analyzePermissionSet(psData, settings);

    const typeLabel = psData.isOwnedByProfile
      ? `Profile: ${psData.profileName || psData.label}`
      : `Permission Set: ${psData.label}`;

    let displayText = `${typeLabel} (assigned to ${psData.assignedUserCount} user(s))\n`;
    displayText += `Overall Risk: ${analysis.overallRiskLevel}\n\n`;
    displayText += analysis.summary + '\n';

    if (analysis.risks.length > 0) {
      displayText += '\nRisks:\n';
      for (const risk of analysis.risks) {
        displayText += `  ${risk.severity}: ${risk.description}\n`;
        displayText += `  Recommendation: ${risk.recommendation}\n\n`;
      }
    }

    return res.json({
      success: true,
      displayText,
      permissionSet: {
        id: psData.id,
        name: psData.name,
        label: psData.label,
        isProfile: psData.isOwnedByProfile,
        profileName: psData.profileName,
        description: psData.description,
        license: psData.license,
        assignedUsers: psData.assignedUserCount,
      },
      analysis: {
        summary: analysis.summary,
        overallRiskLevel: analysis.overallRiskLevel,
        objectAccess: analysis.objectAccess,
        systemPermissions: analysis.systemPermissions,
        risks: analysis.risks,
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Error in analyze-permission endpoint:', error);
    const errorMessage = error instanceof Error ? error.message : 'Internal server error';
    if (errorMessage.includes('not found')) {
      return res.status(404).json({ error: errorMessage });
    }
    return res.status(500).json({ error: errorMessage });
  }
});

/**
 * @swagger
 * /api/v1/find-permission-sources:
 *   post:
 *     summary: Find Permission Sources
 *     description: >
 *       Reverse permission lookup — given a natural-language query like
 *       "edit Account", "edit Account BillingStreet", or "export reports",
 *       returns every Permission Set and Profile that grants that access.
 *       Resolves synonyms (e.g. "Address" → BillingStreet/ShippingStreet,
 *       "modify" → Edit, "remove" → Delete).
 *     tags:
 *       - Security
 *     security:
 *       - ApiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - query
 *             properties:
 *               query:
 *                 type: string
 *                 description: >
 *                   Natural-language permission query. Examples:
 *                   "edit Account", "delete Opportunity",
 *                   "edit Account BillingStreet", "export reports"
 *                 example: edit Account
 *     responses:
 *       200:
 *         description: List of Permission Sets and Profiles that grant the requested access
 *       400:
 *         description: Missing query parameter
 */
router.post('/find-permission-sources', async (req: Request, res: Response) => {
  try {
    const { tenant } = req as AuthenticatedRequest;
    const orgId = tenant.orgId;
    const query = req.query.query ?? req.body?.query;

    if (!query) {
      return res.status(400).json({
        error: 'query is required',
        examples: [
          'edit Account',
          'delete Opportunity',
          'edit Account BillingStreet',
          'export reports',
        ],
      });
    }

    const authService = new SalesforceAuthService();
    const salesforceService = new SalesforceService(authService);

    console.log(`[Find Permission Sources] Query: "${query}"`);
    const result = await salesforceService.findPermissionSources(orgId, String(query));
    console.log(`[Find Permission Sources] Found ${result.sources.length} source(s) for "${result.resolvedQuery}"`);

    return res.json({
      success: true,
      originalQuery: query,
      resolvedQuery: result.resolvedQuery,
      queryType: result.queryType,
      resolvedObject: result.resolvedObject || null,
      resolvedField: result.resolvedField || null,
      resolvedAction: result.resolvedAction || null,
      resolvedSystemPermission: result.resolvedSystemPermission || null,
      sourceCount: result.sources.length,
      sources: result.sources,
      displayText: result.displayText,
    });
  } catch (error) {
    console.error('Error in find-permission-sources endpoint:', error);
    const errorMessage = error instanceof Error ? error.message : 'Internal server error';
    return res.status(errorMessage.includes('Could not understand') ? 400 : 500).json({
      error: errorMessage,
    });
  }
});

/**
 * @swagger
 * /api/v1/explain-metadata:
 *   post:
 *     summary: Explain Validation Rule or Formula Field
 *     tags:
 *       - Monitoring
 *     security:
 *       - ApiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - name
 *               - type
 *             properties:
 *               name:
 *                 type: string
 *               type:
 *                 type: string
 *                 enum: [ValidationRule, FormulaField]
 *               objectName:
 *                 type: string
 */
router.post('/explain-metadata', async (req: Request, res: Response) => {
  try {
    const { tenant } = req as AuthenticatedRequest;
    const orgId = tenant.orgId;
    const name = req.query.name ?? req.body.name;
    const type = req.query.type ?? req.body.type;
    const objectName = req.query.objectName ?? req.body.objectName;

    if (!name || !type) {
      return res.status(400).json({
        success: false,
        error: 'Missing required parameters: name and type are required',
      });
    }

    if (type !== 'ValidationRule' && type !== 'FormulaField') {
      return res.status(400).json({
        success: false,
        error: 'type must be either "ValidationRule" or "FormulaField"',
      });
    }

    if (type === 'FormulaField' && !objectName) {
      return res.status(400).json({
        success: false,
        error: 'objectName is required when type is "FormulaField"',
      });
    }

    const authService = new SalesforceAuthService();
    const salesforceService = new SalesforceService(authService);
    const aiService = new AIService();

    const settings = await authService.getOrgSettings(orgId);
    if (!settings) {
      return res.status(404).json({
        success: false,
        error: `Organization ${orgId} not found or not configured`,
      });
    }

    let metadata: any = null;
    let explanation: string;

    if (type === 'ValidationRule') {
      const validationMetadata = await salesforceService.getValidationRuleMetadata(orgId, name);
      if (!validationMetadata) {
        return res.status(404).json({ success: false, error: `Validation Rule "${name}" not found` });
      }
      metadata = { errorConditionFormula: validationMetadata.errorConditionFormula, id: validationMetadata.id };
      explanation = await aiService.interpretMetadataChange(metadata, 'ValidationRule', name, settings);
    } else {
      const formulaMetadata = await salesforceService.getFormulaFieldMetadata(orgId, name, objectName);
      if (!formulaMetadata) {
        return res.status(404).json({ success: false, error: `Formula Field "${name}" not found on object "${objectName}"` });
      }
      metadata = formulaMetadata;
      explanation = await aiService.interpretMetadataChange(formulaMetadata, 'FormulaField', `${objectName}.${name}`, settings);
    }

    const label = type === 'FormulaField' ? `${objectName}.${name}` : name;
    const displayText = `${type}: ${label}\n\n${explanation}`;

    return res.json({
      success: true,
      displayText,
      name,
      type,
      objectName: type === 'FormulaField' ? objectName : undefined,
      explanation,
      metadata,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Error in explain-metadata endpoint:', error);
    const errorMessage = error instanceof Error ? error.message : 'Internal server error';
    return res.status(500).json({ success: false, error: errorMessage });
  }
});

/**
 * @swagger
 * /api/v1/analyze-validation-rules:
 *   post:
 *     summary: Object Validation Audit
 *     description: |
 *       Retrieves all validation rules for a Salesforce object and uses AI to analyze them.
 *       Returns a Validation Health summary, rules grouped by functional area, and suggestions
 *       for rules with vague error messages.
 *     tags:
 *       - Monitoring
 *     security:
 *       - ApiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - objectApiName
 *             properties:
 *               objectApiName:
 *                 type: string
 *                 description: Object API name (e.g. Account, Opportunity, CustomObject__c)
 *                 example: "Account"
 *     responses:
 *       200:
 *         description: Validation rules analysis
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 count:
 *                   type: integer
 *                   description: Total number of validation rules
 *                 activeCount:
 *                   type: integer
 *                   description: Number of active rules
 *                 summary:
 *                   type: string
 *                   description: AI-generated Validation Health summary
 *                 categories:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       name:
 *                         type: string
 *                       rules:
 *                         type: array
 *                         items:
 *                           type: object
 *                           properties:
 *                             validationName:
 *                               type: string
 *                             active:
 *                               type: boolean
 *                             errorMessage:
 *                               type: string
 *                 vagueErrorSuggestions:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       ruleName:
 *                         type: string
 *                       currentMessage:
 *                         type: string
 *                       suggestedMessage:
 *                         type: string
 *       400:
 *         description: Missing objectApiName
 *       404:
 *         description: Object not found or no rules
 *       500:
 *         description: Server error
 */
router.post('/analyze-validation-rules', async (req: Request, res: Response) => {
  try {
    const { tenant } = req as AuthenticatedRequest;
    const objectApiName = String(req.query.objectApiName ?? req.body.objectApiName ?? '').trim();
    const orgId: string = tenant?.orgId ?? res.locals.orgId ?? req.query.orgId ?? req.body.orgId;

    if (!objectApiName) {
      return res.status(400).json({
        success: false,
        error: 'objectApiName is required',
      });
    }

    if (!orgId) {
      return res.status(400).json({
        success: false,
        error: 'orgId is required (send via x-sfdc-org-id header)',
      });
    }

    const authService = new SalesforceAuthService();
    const salesforceService = new SalesforceService(authService);
    const aiService = new AIService();

    const settings = await authService.getOrgSettings(orgId);
    if (!settings) {
      return res.status(404).json({
        success: false,
        error: `Organization ${orgId} not found or not configured`,
      });
    }

    const rules = await salesforceService.getValidationRulesForObjectAudit(orgId, objectApiName);

    if (rules.length === 0) {
      return res.status(404).json({
        success: false,
        error: `No validation rules found for object ${objectApiName}`,
      });
    }

    const analysis = await aiService.analyzeValidationRulesForObject(objectApiName, rules, settings);

    const activeCount = rules.filter(r => r.active).length;

    let displayText = `Validation Rules for ${objectApiName}: ${rules.length} total, ${activeCount} active.\n\n`;
    displayText += analysis.summary + '\n';

    if (analysis.categories.length > 0) {
      displayText += '\nCategories:\n';
      for (const cat of analysis.categories) {
        displayText += `  ${cat.name} (${cat.rules.length} rule(s))\n`;
      }
    }

    if (analysis.vagueErrorSuggestions.length > 0) {
      displayText += `\n${analysis.vagueErrorSuggestions.length} rule(s) have vague error messages that should be improved.`;
      displayText += ' Ask me for the full list of suggestions if you want details.';
    }

    return res.json({
      success: true,
      displayText,
      count: rules.length,
      activeCount,
      summary: analysis.summary,
      categories: analysis.categories,
      vagueErrorSuggestions: analysis.vagueErrorSuggestions,
    });
  } catch (error) {
    console.error('Error in analyze-validation-rules endpoint:', error);
    const errorMessage = error instanceof Error ? error.message : 'Internal server error';
    return res.status(500).json({
      success: false,
      error: errorMessage,
    });
  }
});

/**
 * @swagger
 * /api/v1/explain-validation-rules:
 *   post:
 *     summary: Explain Each Validation Rule
 *     description: >
 *       Fetches every validation rule on an object (including formulas) and uses AI
 *       to produce a per-rule summary and impact level (CRITICAL / NORMAL).
 *     tags:
 *       - Security
 *     security:
 *       - ApiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - objectApiName
 *             properties:
 *               objectApiName:
 *                 type: string
 *                 description: Object API name (e.g. Account, Opportunity)
 *                 example: Account
 *     responses:
 *       200:
 *         description: Per-rule AI analysis with impact levels
 *       400:
 *         description: Missing objectApiName
 *       404:
 *         description: No validation rules found
 */
router.post('/explain-validation-rules', async (req: Request, res: Response) => {
  try {
    const { tenant } = req as AuthenticatedRequest;
    const orgId = tenant.orgId;
    const objectApiName = String(req.query.objectApiName ?? req.body.objectApiName ?? '').trim();

    if (!objectApiName) {
      return res.status(400).json({
        success: false,
        error: 'objectApiName is required',
        example: { objectApiName: 'Account' },
      });
    }

    const authService = new SalesforceAuthService();
    const salesforceService = new SalesforceService(authService);
    const aiService = new AIService();

    const settings = await authService.getOrgSettings(orgId);
    if (!settings) {
      return res.status(404).json({ success: false, error: `Organization ${orgId} not found or not configured` });
    }

    console.log(`[Explain Validation Rules] Fetching rules for ${objectApiName}`);
    const rules = await salesforceService.getValidationRulesDetailedForAudit(orgId, objectApiName);

    if (rules.length === 0) {
      return res.status(404).json({ success: false, error: `No validation rules found for object ${objectApiName}` });
    }

    console.log(`[Explain Validation Rules] Analyzing ${rules.length} rule(s) with AI`);
    const analysis = await aiService.analyzeValidationRulesDetailed(objectApiName, rules, settings);

    const activeCount = rules.filter(r => r.active).length;
    const criticalCount = analysis.filter(r => r.impact === 'CRITICAL').length;

    let displayText = `Validation Rules for ${objectApiName}: ${rules.length} total, ${activeCount} active, ${criticalCount} critical.\n`;

    for (const rule of analysis) {
      const status = rule.active ? 'Active' : 'Inactive';
      displayText += `\n${rule.validationName} (${status})\n`;
      displayText += `  ${rule.summary}\n`;
      displayText += `  Impact: ${rule.impact} - ${rule.impactReason}\n`;
    }

    return res.json({
      success: true,
      displayText,
      objectApiName,
      count: rules.length,
      activeCount,
      criticalCount,
      rules: analysis,
    });
  } catch (error) {
    console.error('Error in explain-validation-rules endpoint:', error);
    const errorMessage = error instanceof Error ? error.message : 'Internal server error';
    return res.status(500).json({ success: false, error: errorMessage });
  }
});

/**
 * @swagger
 * /api/v1/compare-flow-versions:
 *   post:
 *     summary: Compare or analyze Flow versions
 *     tags:
 *       - Monitoring
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - name: flowName
 *         in: query
 *         required: true
 *         schema:
 *           type: string
 *       - name: versionA
 *         in: query
 *         schema:
 *           type: integer
 *       - name: versionB
 *         in: query
 *         schema:
 *           type: integer
 *       - name: analyze
 *         in: query
 *         schema:
 *           type: boolean
 */
router.post('/compare-flow-versions', async (req: Request, res: Response) => {
  try {
    const { tenant } = req as AuthenticatedRequest;
    const orgId = tenant.orgId;
    const flowName = String(req.query.flowName ?? req.body.flowName ?? '').trim();
    const analyzeOnly = String(req.query.analyze ?? req.body.analyze ?? '') === 'true';
    const rawA = req.query.versionA ?? req.body.versionA;
    const rawB = req.query.versionB ?? req.body.versionB;
    const versionA = rawA ? parseInt(String(rawA), 10) : undefined;
    const versionB = rawB ? parseInt(String(rawB), 10) : undefined;

    if (!flowName) {
      return res.status(400).json({ success: false, error: 'flowName is required (label or API name)' });
    }

    console.log(`[CompareFlow][START] orgId=${orgId} flowName=${flowName} versionA=${String(versionA)} versionB=${String(versionB)} analyzeOnly=${analyzeOnly}`);

    const authService = new SalesforceAuthService();
    const salesforceService = new SalesforceService(authService);
    const aiService = new AIService();

    const settings = await authService.getOrgSettings(orgId);
    if (!settings) {
      return res.status(400).json({ success: false, error: 'Could not load org settings' });
    }

    if (analyzeOnly) {
      let latest;
      try {
        latest = await salesforceService.getLatestFlowVersion(orgId, flowName);
      } catch (sfError) {
        console.error(`[CompareFlow][SF] Failed to fetch latest flow version orgId=${orgId} flowName=${flowName}:`, sfError);
        throw sfError;
      }
      let analysis: string;
      try {
        analysis = await aiService.analyzeFlowVersion(
          latest.metadata, latest.developerName, latest.version, settings
        );
      } catch (llmError) {
        console.error(`[CompareFlow][LLM] Failed to analyze latest flow version orgId=${orgId} flowName=${flowName}:`, llmError);
        throw llmError;
      }
      const flowUrl = `${settings.instanceUrl}/builder_platform_interaction/flowBuilder.app?flowDefId=${latest.definitionId}`;
      const displayText = `Flow: ${latest.label} (v${latest.version})\n\n${analysis}\n\nOpen in Flow Builder: ${flowUrl}`;
      console.log(`[CompareFlow][SUCCESS] orgId=${orgId} flowName=${flowName} mode=analyze`);
      return res.json({ success: true, displayText });
    }

    if (versionA !== undefined && (isNaN(versionA) || versionA < 1)) {
      return res.status(400).json({ success: false, error: 'versionA must be a positive integer' });
    }
    if (versionB !== undefined && (isNaN(versionB) || versionB < 1)) {
      return res.status(400).json({ success: false, error: 'versionB must be a positive integer' });
    }
    if (versionA !== undefined && versionB !== undefined && versionA === versionB) {
      return res.status(400).json({ success: false, error: 'versionA and versionB must be different' });
    }

    let versions;
    try {
      versions = await salesforceService.getFlowVersionsByNumber(orgId, flowName, versionA, versionB);
    } catch (sfError) {
      console.error(`[CompareFlow][SF] Failed to fetch flow versions orgId=${orgId} flowName=${flowName}:`, sfError);
      throw sfError;
    }

    const older = versions.versionA.version < versions.versionB.version ? versions.versionA : versions.versionB;
    const newer = versions.versionA.version < versions.versionB.version ? versions.versionB : versions.versionA;

    let comparison: string;
    try {
      comparison = await aiService.compareFlowVersions(
        older.metadata, newer.metadata,
        versions.developerName,
        older.version, newer.version,
        settings
      );
    } catch (llmError) {
      console.error(`[CompareFlow][LLM] Failed to compare flow versions orgId=${orgId} flowName=${flowName}:`, llmError);
      throw llmError;
    }

    const flowUrl = `${settings.instanceUrl}/builder_platform_interaction/flowBuilder.app?flowDefId=${versions.definitionId}`;
    const displayText = `Flow: ${versions.label} — Version ${older.version} vs Version ${newer.version}\n\n${comparison}\n\nOpen in Flow Builder: ${flowUrl}`;

    console.log(`[CompareFlow][SUCCESS] orgId=${orgId} flowName=${flowName} mode=compare`);
    return res.json({ success: true, displayText });
  } catch (error) {
    console.error('[CompareFlow][UNHANDLED] Error in compare-flow-versions endpoint:', error);
    const errorMessage = error instanceof Error ? error.message : 'Internal server error';
    return res.status(500).json({ success: false, error: errorMessage });
  }
});

export default router;
