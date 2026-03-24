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
    return res.json({
      success: result.success,
      message: result.success
        ? `Manual check completed (${timeWindow}). Found ${result.changesFound} change(s).`
        : 'Manual check completed with errors.',
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
        /(?:ValidationRule|Validation Rule):\s*(.+?)(?:\s|$)/i,
        /validation rule\s+(.+?)(?:\s|$)/i,
        /validation\s+["']([^"']+)["']/i,
        /rule\s+["']?([^"'\s]+)["']?/i,
        /"([^"]+)"(?:\s+validation|$)/i,
      ];
      for (const pattern of patterns) {
        const match = display.match(pattern);
        if (match?.[1]) return match[1].trim();
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

    const changes = await Promise.all(
      auditRecords.map(async (record) => {
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
              try {
                const validationMetadata = await salesforceService.getValidationRuleMetadata(orgId, ruleName);
                if (validationMetadata) {
                  const metadata = {
                    errorConditionFormula: validationMetadata.errorConditionFormula,
                    id: validationMetadata.id,
                  };
                  change.explanation = await aiService.interpretMetadataChange(metadata, 'ValidationRule', ruleName, settings);
                  change.metadataName = ruleName;
                  change.metadataType = 'ValidationRule';
                }
              } catch (error) {
                console.warn(`[Recent Changes] Could not fetch explanation for validation rule ${ruleName}:`, error);
              }
            }
          } else if (isFormulaFieldAction(record.Action)) {
            const fieldName = extractFieldName(record.Display || '');
            const objectName = extractObjectNameFromSection(record.Section || '') ||
              (record.Display?.match(/([A-Za-z0-9_]+)\.([A-Za-z0-9_]+)/)?.[1]) ||
              'Unknown';

            if (fieldName && objectName !== 'Unknown') {
              try {
                const formulaMetadata = await salesforceService.getFormulaFieldMetadata(orgId, fieldName, objectName);
                if (formulaMetadata) {
                  change.explanation = await aiService.interpretMetadataChange(formulaMetadata, 'FormulaField', `${objectName}.${fieldName}`, settings);
                  change.metadataName = `${objectName}.${fieldName}`;
                  change.metadataType = 'FormulaField';
                }
              } catch (error) {
                console.warn(`[Recent Changes] Could not fetch explanation for formula field ${objectName}.${fieldName}:`, error);
              }
            }
          }
        } catch (error) {
          console.warn(`[Recent Changes] Error generating explanation for ${record.Action}:`, error);
        }

        return change;
      })
    );

    return res.json({
      count: changes.length,
      changes,
      note: 'This endpoint is read-only. To trigger Slack notifications, use POST /api/v1/trigger-check',
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
 *     summary: Trace User Permissions
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
 *               - userId
 *             properties:
 *               userId:
 *                 type: string
 *               permissionName:
 *                 type: string
 */
router.post('/analyze-permission', async (req: Request, res: Response) => {
  try {
    const { tenant } = req as AuthenticatedRequest;
    const orgId = tenant.orgId;
    const userId = req.query.userId ?? req.body?.userId;
    const permissionName = req.query.permissionName ?? req.body?.permissionName;

    if (!userId) {
      return res.status(400).json({ error: 'userId is required' });
    }

    const authService = new SalesforceAuthService();
    const salesforceService = new SalesforceService(authService);

    if (permissionName) {
      try {
        const analysis = await salesforceService.analyzePermissions(orgId, userId, permissionName);
        return res.json({
          username: analysis.username,
          userId: analysis.userId,
          checkingPermission: analysis.checkingPermission,
          resolvedLabel: analysis.resolvedLabel,
          hasAccess: analysis.hasAccess,
          sources: analysis.sources,
          explanation: analysis.explanation,
          riskAnalysis: analysis.riskAnalysis,
        });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Internal server error';
        if (errorMessage.includes('not found') || errorMessage.includes('User not found')) {
          return res.status(404).json({ error: errorMessage });
        }
        return res.status(500).json({ error: errorMessage });
      }
    }

    const conn = await authService.getConnection(orgId);
    const userQuery = userId.includes('@')
      ? `SELECT Id, Username, Name, Email FROM User WHERE Username = '${userId.replace(/'/g, "''")}' LIMIT 1`
      : `SELECT Id, Username, Name, Email FROM User WHERE Id = '${userId.replace(/'/g, "''")}' LIMIT 1`;

    const userResult = await conn.query<any>(userQuery);
    if (!userResult.records?.length) {
      return res.status(404).json({ error: `User not found: ${userId}` });
    }

    const user = userResult.records[0];
    const permissionSetQuery = `
      SELECT Id, Name, Label
      FROM PermissionSetAssignment
      WHERE AssigneeId = '${user.Id.replace(/'/g, "''")}'
    `;
    const permissionSetResult = await conn.query<any>(permissionSetQuery);
    const permissionSetCount = permissionSetResult.totalSize || 0;

    const profileQuery = `SELECT Id, Name FROM Profile WHERE Id = '${user.Id.replace(/'/g, "''")}' LIMIT 1`;
    const profileResult = await conn.query<any>(profileQuery);

    let riskAnalysis = 'Low';
    if (permissionSetCount > 10) riskAnalysis = 'Medium';
    if (permissionSetCount > 20) riskAnalysis = 'High';

    return res.json({
      username: user.Username,
      name: user.Name,
      email: user.Email,
      userId: user.Id,
      permissionSets: permissionSetCount,
      profile: profileResult.records?.[0]?.Name || 'Unknown',
      riskAnalysis,
      timestamp: new Date().toISOString(),
      message: 'No permission specified. Provide permissionName to check specific permissions.',
    });
  } catch (error) {
    console.error('Error in analyze-permission endpoint:', error);
    const errorMessage = error instanceof Error ? error.message : 'Internal server error';
    return res.status(500).json({ error: errorMessage });
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

    return res.json({
      success: true,
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
 *       for rules with vague error messages. Org is identified via x-sfdc-org-id header.
 *     tags:
 *       - Monitoring
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

    return res.json({
      success: true,
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

    let diff;
    try {
      diff = await aiService.generateSummary(older.metadata, newer.metadata, versions.developerName, settings);
    } catch (llmError) {
      console.error(`[CompareFlow][LLM] Failed to generate diff orgId=${orgId} flowName=${flowName}:`, llmError);
      throw llmError;
    }

    const flowUrl = `${settings.instanceUrl}/builder_platform_interaction/flowBuilder.app?flowDefId=${versions.definitionId}`;
    const changes = diff.changes || [];
    const findings = diff.securityFindings || [];
    const changesList = changes.length > 0 ? '\n' + changes.map(c => `- ${c}`).join('\n') : '';
    const secList = findings.length > 0 ? '\nSecurity: ' + findings.join(', ') : '';
    const displayText = `Flow: ${versions.label} (v${older.version} vs v${newer.version})\n\n${diff.summary}${changesList}${secList}\n\nOpen in Flow Builder: ${flowUrl}`;

    console.log(`[CompareFlow][SUCCESS] orgId=${orgId} flowName=${flowName} mode=compare`);
    return res.json({ success: true, displayText });
  } catch (error) {
    console.error('[CompareFlow][UNHANDLED] Error in compare-flow-versions endpoint:', error);
    const errorMessage = error instanceof Error ? error.message : 'Internal server error';
    return res.status(500).json({ success: false, error: errorMessage });
  }
});

export default router;
