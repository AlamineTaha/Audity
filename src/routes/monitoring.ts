/**
 * Monitoring Routes
 * REST API endpoints for proactive monitoring and manual triggers
 */

import { Router, Request, Response } from 'express';
import { MonitorService } from '../services/monitorService';
import { SalesforceService } from '../services/salesforceService';
import { AIService } from '../services/aiService';
import { SalesforceAuthService } from '../services/authService';

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
      10 // checkIntervalMinutes — no Waiting Room; uses Threaded Ledger for Flows
    );
  }
  return monitorService;
}

/**
 * No-op: Waiting Room removed; Flows use Threaded Ledger (flow_thread Redis keys)
 */
export async function ensureWaitingRoomStarted(): Promise<void> {
  getMonitorService();
}

/**
 * @swagger
 * /api/v1/trigger-check:
 *   post:
 *     summary: Force Immediate Change Check
 *     description: Manually triggers the polling engine to check for Salesforce changes immediately, analyze them with AI, and send Slack alerts if issues are found. Use the `hours` query parameter to check for changes in the past X hours (e.g., `?hours=12`).
 *     tags:
 *       - Monitoring
 *     parameters:
 *       - in: query
 *         name: hours
 *         schema:
 *           type: integer
 *         description: Optional. Look back X hours instead of default time window (300 seconds).
 *         example: 12
 *       - in: query
 *         name: debug
 *         schema:
 *           type: boolean
 *           default: false
 *         description: If true, skip isAuditRecordProcessed check to re-test the same change without clearing Redis cache.
 *       - in: query
 *         name: forceImmediate
 *         schema:
 *           type: boolean
 *           default: false
 *         description: Bypass aggregation for on-demand triggers.
 *     responses:
 *       200:
 *         description: Check initiated
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 message:
 *                   type: string
 *                   example: "Manual check completed (12 hour(s)). Found 5 change(s)."
 *                 changesFound:
 *                   type: integer
 *                 errors:
 *                   type: array
 *                   items:
 *                     type: string
 *                 timeWindow:
 *                   type: string
 *                   description: The time window used for the check
 *                   example: "12 hours"
 *       400:
 *         description: Bad request - invalid hours parameter
 */
/**
 * Safe Slack invite - Flow calls before posting to avoid already_in_channel errors
 * Body: { channelId: string, userIds: string | string[] } (comma-separated or array)
 */
router.post('/slack-invite', async (req: Request, res: Response) => {
  try {
    const { channelId, userIds } = req.body;
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
 * Callback for Salesforce Flow to store Slack thread_ts after posting
 * Flow calls this after sending to Slack; we store for threaded replies (36h TTL)
 */
router.post('/slack-thread-callback', async (req: Request, res: Response) => {
  try {
    const { orgId, flowDeveloperName, threadTs } = req.body;
    if (!orgId || !flowDeveloperName || !threadTs) {
      return res.status(400).json({
        success: false,
        error: 'orgId, flowDeveloperName, and threadTs are required',
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
 * Clear audit_processed Redis cache (for re-testing)
 * POST /api/v1/clear-audit-cache
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

router.post('/trigger-check', async (req: Request, res: Response) => {
  try {
    const { hours, debug } = req.query;
    const hoursNum = hours ? parseInt(hours as string, 10) : undefined;
    
    // Validate hours parameter if provided
    if (hoursNum !== undefined && (isNaN(hoursNum) || hoursNum < 1)) {
      return res.status(400).json({
        success: false,
        message: 'hours must be a positive integer',
        changesFound: 0,
        errors: ['Invalid hours parameter'],
      });
    }

    const service = getMonitorService();
    const forceImmediate = req.query.forceImmediate === 'true' || req.query.immediate === 'true';
    const debugMode = debug === 'true';
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
 *     description: |
 *       Retrieves a list of metadata changes from the Audit Trail with AI-powered explanations for Validation Rules and Formula Fields.
 *       
 *       **AI Explanations:** For Validation Rules and Formula Fields, the response includes human-readable explanations
 *       that describe what the change means in business terms. This helps non-technical users understand the impact.
 *       
 *       **Supported Change Types:**
 *       - Validation Rules: `changedValidationFormula`, `changedValidationMessage`, `createdValidationRule`, `changedValidationRule`, `deletedValidationRule`
 *       - Formula Fields: `createdCFFormula`, `changedCFFormula`, `deletedCFFormula`
 *       - Other changes: All other audit trail entries are included without AI explanations
 *     tags:
 *       - Monitoring
 *     operationId: getRecentChanges
 *     parameters:
 *       - in: query
 *         name: orgId
 *         required: true
 *         description: Salesforce Organization ID (required)
 *         schema:
 *           type: string
 *         example: "00DJ6000001H7etMAC"
 *       - in: query
 *         name: hours
 *         required: false
 *         description: Lookback window in hours (optional, defaults to 24)
 *         schema:
 *           type: integer
 *           default: 24
 *         example: 24
 *     responses:
 *       200:
 *         description: List of recent changes with AI explanations for Validation Rules and Formula Fields
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
 *                 properties:
 *                   action:
 *                     type: string
 *                     description: Salesforce action code
 *                     example: "changedValidationFormula"
 *                   user:
 *                     type: string
 *                     description: User who made the change
 *                     example: "Alice Smith"
 *                   section:
 *                     type: string
 *                     description: Section where the change occurred
 *                     example: "Customize Accounts"
 *                   timestamp:
 *                     type: string
 *                     format: date-time
 *                     description: When the change occurred
 *                     example: "2026-01-15T10:30:00.000Z"
 *                   display:
 *                     type: string
 *                     description: Human-readable description of the change
 *                     example: "Changed validation rule In_dustry_validation_rule"
 *                   id:
 *                     type: string
 *                     description: Audit trail record ID
 *                     example: "0Ya..."
 *                   explanation:
 *                     type: string
 *                     description: AI-generated explanation in business terms (only for Validation Rules and Formula Fields)
 *                     example: "This validation rule blocks users from saving Account records where the Industry field is not set to 'Technology'."
 *                   metadataName:
 *                     type: string
 *                     description: API name of the metadata item (only for Validation Rules and Formula Fields)
 *                     example: "In_dustry_validation_rule" or "Account.Formula_Test__c"
 *                   metadataType:
 *                     type: string
 *                     enum: [ValidationRule, FormulaField]
 *                     description: Type of metadata (only for Validation Rules and Formula Fields)
 *                     example: "ValidationRule"
 *             examples:
 *               withExplanations:
 *                 summary: Changes with AI explanations
 *                 value:
 *                   - action: "changedValidationFormula"
 *                     user: "John Doe"
 *                     section: "Customize Accounts"
 *                     timestamp: "2026-01-15T10:30:00.000Z"
 *                     display: "Changed validation rule In_dustry_validation_rule"
 *                     id: "0Ya..."
 *                     explanation: "This validation rule blocks users from saving Account records where the Industry field is not set to 'Technology'."
 *                     metadataName: "In_dustry_validation_rule"
 *                     metadataType: "ValidationRule"
 *                   - action: "changedCFFormula"
 *                     user: "Jane Smith"
 *                     section: "Customize Accounts"
 *                     timestamp: "2026-01-15T11:00:00.000Z"
 *                     display: "Changed custom formula field: Formula_Test__c"
 *                     id: "0Yb..."
 *                     explanation: "This formula field automatically calculates a 10% commission based on the Account's Annual Revenue."
 *                     metadataName: "Account.Formula_Test__c"
 *                     metadataType: "FormulaField"
 *                   - action: "accountlayout"
 *                     user: "Bob Johnson"
 *                     section: "Customize Accounts"
 *                     timestamp: "2026-01-15T12:00:00.000Z"
 *                     display: "Changed page layout Account Layout"
 *                     id: "0Yc..."
 *       400:
 *         description: Bad request - missing orgId or invalid hours parameter
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: "orgId query parameter is required"
 *       404:
 *         description: Organization not found or not configured
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: "Organization 00DJ6000001H7etMAC not found or not configured"
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: "Internal server error"
 */
router.get('/recent-changes', async (req: Request, res: Response) => {
  console.log(`[Recent Changes] Endpoint called - Query params:`, req.query);
  
  try {
    const { orgId, hours } = req.query;

    console.log(`[Recent Changes] Processing request - orgId: ${orgId}, hours: ${hours}`);

    if (!orgId || typeof orgId !== 'string') {
      console.warn(`[Recent Changes] Missing or invalid orgId parameter`);
      return res.status(400).json({
        error: 'orgId query parameter is required',
      });
    }

    const hoursNum = hours ? parseInt(hours as string, 10) : 24;
    if (isNaN(hoursNum) || hoursNum < 1) {
      console.warn(`[Recent Changes] Invalid hours parameter: ${hours}`);
      return res.status(400).json({
        error: 'hours must be a positive integer',
      });
    }

    console.log(`[Recent Changes] Initializing services for orgId: ${orgId}, hours: ${hoursNum}`);
    const authService = new SalesforceAuthService();
    const salesforceService = new SalesforceService(authService);
    const aiService = new AIService();

    // Get org settings for billing mode
    console.log(`[Recent Changes] Fetching org settings for: ${orgId}`);
    const settings = await authService.getOrgSettings(orgId);
    if (!settings) {
      console.error(`[Recent Changes] Organization ${orgId} not found or not configured`);
      return res.status(404).json({
        error: `Organization ${orgId} not found or not configured`,
      });
    }

    console.log(`[Recent Changes] Querying audit trail for orgId: ${orgId}, last ${hoursNum} hours`);
    const auditRecords = await salesforceService.queryAuditTrailByHours(orgId, hoursNum);
    console.log(`[Recent Changes] Found ${auditRecords.length} audit record(s)`);

    // Helper function to check if action is validation-related
    const isValidationAction = (action: string): boolean => {
      return [
        'changedValidationFormula',
        'changedValidationMessage',
        'createdValidationRule',
        'changedValidationRule',
        'deletedValidationRule'
      ].includes(action);
    };

    // Helper function to check if action is formula field-related
    const isFormulaFieldAction = (action: string): boolean => {
      return [
        'createdCFFormula',
        'changedCFFormula',
        'deletedCFFormula'
      ].includes(action);
    };

    // Helper function to extract validation rule name from Display field
    const extractValidationRuleName = (display: string): string | null => {
      const patterns = [
        /(?:ValidationRule|Validation Rule):\s*(.+?)(?:\s|$)/i,
        /validation rule\s+(.+?)(?:\s|$)/i,
        /validation\s+["']([^"']+)["']/i,  // Handles: "Changed error message for Accounts validation "RuleName""
        /rule\s+["']?([^"'\s]+)["']?/i,
        /"([^"]+)"(?:\s+validation|$)/i
      ];

      for (const pattern of patterns) {
        const match = display.match(pattern);
        if (match && match[1]) {
          return match[1].trim();
        }
      }
      return null;
    };

    // Helper function to extract object name from Section field
    const extractObjectNameFromSection = (section: string): string | null => {
      if (!section) return null;
      const match = section.match(/Customize\s+([A-Za-z0-9_]+)/i);
      if (match && match[1]) {
        let objectName = match[1];
        // Remove plural 's' if present
        if (objectName.endsWith('s') && objectName.length > 1) {
          objectName = objectName.slice(0, -1);
        }
        return objectName;
      }
      return null;
    };

    // Helper function to extract field name from Display field
    const extractFieldName = (display: string): string | null => {
      const patterns = [
        /(?:field|formula field):\s*(.+?)(?:\s*\(|$)/i,
        /\.([A-Za-z0-9_]+__c)/,
        /^([A-Za-z0-9_\s]+?)(?:\s*\(|$)/,
        /"([^"]+)"(?:\s+field|$)/i
      ];

      for (const pattern of patterns) {
        const match = display.match(pattern);
        if (match && match[1]) {
          return match[1].trim();
        }
      }
      return null;
    };

    // Process changes with AI explanations for validation rules and formula fields
    console.log(`[Recent Changes] Processing ${auditRecords.length} record(s) with AI explanations`);
    const changes = await Promise.all(
      auditRecords.map(async (record, index) => {
        if (index === 0 || index % 10 === 0) {
          console.log(`[Recent Changes] Processing record ${index + 1}/${auditRecords.length}: ${record.Action} - ${record.Display?.substring(0, 50)}...`);
        }
        const change: any = {
          action: record.Action,
          user: record.CreatedBy.Name,
          section: record.Section,
          timestamp: record.CreatedDate,
          display: record.Display,
          id: record.Id,
        };

        try {
          // Add AI explanation for Validation Rules
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
                  change.explanation = await aiService.interpretMetadataChange(
                    metadata,
                    'ValidationRule',
                    ruleName,
                    settings
                  );
                  change.metadataName = ruleName;
                  change.metadataType = 'ValidationRule';
                }
              } catch (error) {
                console.warn(`[Recent Changes] Could not fetch explanation for validation rule ${ruleName}:`, error);
                // Continue without explanation
              }
            }
          }
          // Add AI explanation for Formula Fields
          else if (isFormulaFieldAction(record.Action)) {
            const fieldName = extractFieldName(record.Display || '');
            const objectName = extractObjectNameFromSection(record.Section || '') || 
                             (record.Display?.match(/([A-Za-z0-9_]+)\.([A-Za-z0-9_]+)/)?.[1]) ||
                             'Unknown';

            if (fieldName && objectName !== 'Unknown') {
              try {
                const formulaMetadata = await salesforceService.getFormulaFieldMetadata(
                  orgId,
                  fieldName,
                  objectName
                );
                if (formulaMetadata) {
                  change.explanation = await aiService.interpretMetadataChange(
                    formulaMetadata,
                    'FormulaField',
                    `${objectName}.${fieldName}`,
                    settings
                  );
                  change.metadataName = `${objectName}.${fieldName}`;
                  change.metadataType = 'FormulaField';
                }
              } catch (error) {
                console.warn(`[Recent Changes] Could not fetch explanation for formula field ${objectName}.${fieldName}:`, error);
                // Continue without explanation
              }
            }
          }
        } catch (error) {
          // If explanation fails, still return the change without explanation
          console.warn(`[Recent Changes] Error generating explanation for ${record.Action}:`, error);
        }

        return change;
      })
    );

    console.log(`[Recent Changes] Successfully processed ${changes.length} change(s). Returning response.`);
    
    // Note: This endpoint is READ-ONLY and does NOT create AuditDelta_Event__c records.
    // To trigger notifications, use POST /api/v1/trigger-check instead.
    return res.json({
      count: changes.length,
      changes,
      note: 'This endpoint is read-only. To trigger Slack notifications, use POST /api/v1/trigger-check'
    });
  } catch (error) {
    console.error('[Recent Changes] Error in recent-changes endpoint:', error);
    const errorMessage = error instanceof Error ? error.message : 'Internal server error';
    console.error('[Recent Changes] Error details:', error instanceof Error ? error.stack : error);
    return res.status(500).json({
      error: errorMessage,
    });
  }
});

/**
 * @swagger
 * /api/v1/analyze-permission:
 *   post:
 *     summary: Trace User Permissions
 *     description: |
 *       Analyzes a specific user's permissions. Traces exactly which Profile or Permission Set grants a permission.
 *       Useful for Agentforce to answer 'Why can User X do Y?'.
 *       
 *       **System Permissions:** Supports natural language queries (e.g., "create report", "export reports", "modify all data") 
 *       or exact API names (e.g., "PermissionsCreateReport", "PermissionsExportReport").
 *       
 *       **Object Permissions:** Use format "Action Object" (e.g., "Edit Account", "Delete Lead", "Create Contact", "Read Opportunity").
 *       **Field Permissions:** Use format "Action Object Field" (e.g., "Edit Account Description", "Read Contact Email").
 *       
 *       **Action Keywords:** Use these exact strings for the action parameter:
 *       - 'Read' - Check read access
 *       - 'Create' - Check create access
 *       - 'Edit' - Check edit access
 *       - 'Delete' - Check delete access
 *       - 'ViewAll' - Check view all records access (bypasses sharing)
 *       - 'ModifyAll' - Check modify all records access (god mode)
 *     tags:
 *       - Security
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - userId
 *               - orgId
 *             properties:
 *               userId:
 *                 type: string
 *                 description: Salesforce User ID (18-character) or Username (email)
 *                 example: "005J6000002RB2uIAG"
 *               orgId:
 *                 type: string
 *                 description: Salesforce Organization ID
 *                 example: "00DJ6000001H7etMAC"
 *               permissionName:
 *                 type: string
 *                 description: |
 *                   Permission to check. Supports:
 *                   - System Permissions: natural language (e.g., "create report", "export reports") or exact API name (e.g., "PermissionsCreateReport")
 *                   - Object Permissions: format "Action Object" (e.g., "Edit Account", "Delete Lead", "Create Contact")
 *                   If not provided, returns basic user info without permission analysis.
 *                 example: "Edit Account"
 *     responses:
 *       200:
 *         description: Permission analysis result
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 username:
 *                   type: string
 *                   description: User's full name
 *                   example: "Alice Smith"
 *                 userId:
 *                   type: string
 *                   description: Salesforce User ID
 *                   example: "005J6000002RB2uIAG"
 *                 checkingPermission:
 *                   type: string
 *                   description: The resolved API name of the permission checked
 *                   example: "PermissionsCreateReport"
 *                 resolvedLabel:
 *                   type: string
 *                   description: Human-readable label of the permission checked
 *                   example: "Create Report"
 *                 hasAccess:
 *                   type: boolean
 *                   description: Whether the user has the requested permission
 *                   example: true
 *                 sources:
 *                   type: array
 *                   description: List of Profiles/Permission Sets that grant this permission
 *                   items:
 *                     type: string
 *                   example: ["Profile: System Administrator", "Permission Set: Marketing Manager"]
 *                 explanation:
 *                   type: string
 *                   description: Human-readable explanation of the permission analysis
 *                   example: "User can do this because it is granted by: Profile: System Administrator, Permission Set: Marketing Manager"
 *                 riskAnalysis:
 *                   type: object
 *                   description: Risk assessment for the permission
 *                   properties:
 *                     riskLevel:
 *                       type: string
 *                       enum: [LOW, MEDIUM, HIGH, CRITICAL]
 *                       description: Risk level of the permission
 *                       example: "HIGH"
 *                     riskReason:
 *                       type: string
 *                       description: Explanation of why this risk level was assigned
 *                       example: "User has 'View All Records' which allows them to see every record in the Account object, regardless of sharing rules."
 *       400:
 *         description: Bad request - missing required fields or invalid JSON
 *       404:
 *         description: User not found
 *       500:
 *         description: Internal server error
 */
router.post('/analyze-permission', async (req: Request, res: Response) => {
  try {
    // Validate request body exists
    if (!req.body || typeof req.body !== 'object') {
      return res.status(400).json({
        error: 'Invalid request body. Expected JSON object.',
      });
    }

    const { userId, permissionName, orgId } = req.body;

    if (!userId) {
      return res.status(400).json({
        error: 'userId is required',
      });
    }

    if (!orgId) {
      return res.status(400).json({
        error: 'orgId is required',
      });
    }

    const authService = new SalesforceAuthService();
    const salesforceService = new SalesforceService(authService);

    // If permissionName is provided, use the smart analyzePermissions method
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
        
        // Handle specific error cases
        if (errorMessage.includes('not found') || errorMessage.includes('User not found')) {
          return res.status(404).json({
            error: errorMessage,
          });
        }
        
        return res.status(500).json({
          error: errorMessage,
        });
      }
    }

    // Fallback: Basic user info without permission check
    const conn = await authService.getConnection(orgId);

    // Query user information
    const userQuery = userId.includes('@')
      ? `SELECT Id, Username, Name, Email FROM User WHERE Username = '${userId.replace(/'/g, "''")}' LIMIT 1`
      : `SELECT Id, Username, Name, Email FROM User WHERE Id = '${userId.replace(/'/g, "''")}' LIMIT 1`;

    const userResult = await conn.query<any>(userQuery);

    if (!userResult.records || userResult.records.length === 0) {
      return res.status(404).json({
        error: `User not found: ${userId}`,
      });
    }

    const user = userResult.records[0];

    // Query permission sets assigned to the user
    const permissionSetQuery = `
      SELECT Id, Name, Label
      FROM PermissionSetAssignment
      WHERE AssigneeId = '${user.Id.replace(/'/g, "''")}'
    `;

    const permissionSetResult = await conn.query<any>(permissionSetQuery);
    const permissionSetCount = permissionSetResult.totalSize || 0;

    // Query profile information
    const profileQuery = `SELECT Id, Name FROM Profile WHERE Id = '${user.Id.replace(/'/g, "''")}' LIMIT 1`;
    const profileResult = await conn.query<any>(profileQuery);

    // Basic risk analysis
    let riskAnalysis = 'Low';
    if (permissionSetCount > 10) {
      riskAnalysis = 'Medium';
    }
    if (permissionSetCount > 20) {
      riskAnalysis = 'High';
    }

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
    return res.status(500).json({
      error: errorMessage,
    });
  }
});

/**
 * @swagger
 * /api/v1/explain-metadata:
 *   post:
 *     summary: Explain Validation Rule or Formula Field
 *     description: |
 *       Fetches metadata for a Validation Rule or Formula Field by API name and provides an AI-powered explanation in business terms.
 *       
 *       **Use Cases:**
 *       - Understand what a validation rule does without reading the formula
 *       - Get a business-friendly explanation of a formula field calculation
 *       - Help non-technical users understand Salesforce metadata
 *       
 *       **For Validation Rules:** Only requires `orgId`, `name`, and `type`.
 *       **For Formula Fields:** Also requires `objectName` parameter.
 *     tags:
 *       - Monitoring
 *     operationId: explainMetadata
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - orgId
 *               - name
 *               - type
 *             properties:
 *               orgId:
 *                 type: string
 *                 description: Salesforce Organization ID
 *                 example: "00DJ6000001H7etMAC"
 *               name:
 *                 type: string
 *                 description: API name of the Validation Rule or Formula Field (e.g., "In_dustry_validation_rule" or "Formula_Test__c")
 *                 example: "In_dustry_validation_rule"
 *               type:
 *                 type: string
 *                 enum: [ValidationRule, FormulaField]
 *                 description: Type of metadata to explain
 *                 example: "ValidationRule"
 *               objectName:
 *                 type: string
 *                 description: Required for FormulaField - Object API Name (e.g., "Account", "Contact", "CustomObject__c")
 *                 example: "Account"
 *           examples:
 *             validationRule:
 *               summary: Explain a Validation Rule
 *               value:
 *                 orgId: "00DJ6000001H7etMAC"
 *                 name: "In_dustry_validation_rule"
 *                 type: "ValidationRule"
 *             formulaField:
 *               summary: Explain a Formula Field
 *               value:
 *                 orgId: "00DJ6000001H7etMAC"
 *                 name: "Formula_Test__c"
 *                 type: "FormulaField"
 *                 objectName: "Account"
 *     responses:
 *       200:
 *         description: Explanation generated successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 name:
 *                   type: string
 *                   description: The API name of the metadata item
 *                   example: "In_dustry_validation_rule"
 *                 type:
 *                   type: string
 *                   enum: [ValidationRule, FormulaField]
 *                   example: "ValidationRule"
 *                 objectName:
 *                   type: string
 *                   description: Object name (only present for FormulaField)
 *                   example: "Account"
 *                 explanation:
 *                   type: string
 *                   description: AI-generated explanation in business terms
 *                   example: "This validation rule blocks users from saving Account records where the Industry field is not set to 'Technology'. It ensures data quality by preventing invalid industry values."
 *                 metadata:
 *                   type: object
 *                   description: Raw metadata from Salesforce
 *                   properties:
 *                     errorConditionFormula:
 *                       type: string
 *                       description: Validation rule formula (for ValidationRule)
 *                       example: "Industry != 'Technology'"
 *                     formula:
 *                       type: string
 *                       description: Formula field calculation (for FormulaField)
 *                       example: "Account.AnnualRevenue * 0.1"
 *                     label:
 *                       type: string
 *                       description: Human-readable label
 *                       example: "10% Commission"
 *                     type:
 *                       type: string
 *                       description: Field type (for FormulaField)
 *                       example: "Currency"
 *                     id:
 *                       type: string
 *                       description: Salesforce metadata ID
 *                       example: "03d..."
 *                 timestamp:
 *                   type: string
 *                   format: date-time
 *                   description: When the explanation was generated
 *                   example: "2026-01-15T10:30:00.000Z"
 *             examples:
 *               validationRule:
 *                 summary: Validation Rule explanation
 *                 value:
 *                   success: true
 *                   name: "In_dustry_validation_rule"
 *                   type: "ValidationRule"
 *                   explanation: "This validation rule blocks users from saving Account records where the Industry field is not set to 'Technology'. It ensures data quality by preventing invalid industry values."
 *                   metadata:
 *                     errorConditionFormula: "Industry != 'Technology'"
 *                     id: "03d..."
 *                   timestamp: "2026-01-15T10:30:00.000Z"
 *               formulaField:
 *                 summary: Formula Field explanation
 *                 value:
 *                   success: true
 *                   name: "Formula_Test__c"
 *                   type: "FormulaField"
 *                   objectName: "Account"
 *                   explanation: "This formula field automatically calculates a 10% commission based on the Account's Annual Revenue. It multiplies the Annual Revenue by 0.1 to determine the commission amount."
 *                   metadata:
 *                     formula: "Account.AnnualRevenue * 0.1"
 *                     label: "Commission"
 *                     type: "Currency"
 *                   timestamp: "2026-01-15T10:30:00.000Z"
 *       400:
 *         description: Bad request - missing required parameters or invalid type
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: false
 *                 error:
 *                   type: string
 *                   example: "Missing required parameters: orgId, name, and type are required"
 *             examples:
 *               missingParams:
 *                 summary: Missing required parameters
 *                 value:
 *                   success: false
 *                   error: "Missing required parameters: orgId, name, and type are required"
 *               invalidType:
 *                 summary: Invalid type value
 *                 value:
 *                   success: false
 *                   error: "type must be either \"ValidationRule\" or \"FormulaField\""
 *               missingObjectName:
 *                 summary: Missing objectName for FormulaField
 *                 value:
 *                   success: false
 *                   error: "objectName is required when type is \"FormulaField\""
 *       404:
 *         description: Metadata not found or organization not configured
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: false
 *                 error:
 *                   type: string
 *                   example: "Validation Rule \"In_dustry_validation_rule\" not found"
 *             examples:
 *               notFound:
 *                 summary: Metadata not found
 *                 value:
 *                   success: false
 *                   error: "Validation Rule \"In_dustry_validation_rule\" not found"
 *               orgNotFound:
 *                 summary: Organization not configured
 *                 value:
 *                   success: false
 *                   error: "Organization 00DJ6000001H7etMAC not found or not configured"
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: false
 *                 error:
 *                   type: string
 *                   example: "Internal server error"
 */
router.post('/explain-metadata', async (req: Request, res: Response) => {
  try {
    const { orgId, name, type, objectName } = req.body;

    // Validate required parameters
    if (!orgId || !name || !type) {
      return res.status(400).json({
        success: false,
        error: 'Missing required parameters: orgId, name, and type are required',
      });
    }

    // Validate type
    if (type !== 'ValidationRule' && type !== 'FormulaField') {
      return res.status(400).json({
        success: false,
        error: 'type must be either "ValidationRule" or "FormulaField"',
      });
    }

    // Validate objectName for FormulaField
    if (type === 'FormulaField' && !objectName) {
      return res.status(400).json({
        success: false,
        error: 'objectName is required when type is "FormulaField"',
      });
    }

    const authService = new SalesforceAuthService();
    const salesforceService = new SalesforceService(authService);
    const aiService = new AIService();

    // Get org settings for billing mode
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
      // Fetch Validation Rule metadata
      const validationMetadata = await salesforceService.getValidationRuleMetadata(orgId, name);
      
      if (!validationMetadata) {
        return res.status(404).json({
          success: false,
          error: `Validation Rule "${name}" not found`,
        });
      }

      metadata = {
        errorConditionFormula: validationMetadata.errorConditionFormula,
        id: validationMetadata.id,
      };

      // Generate AI explanation
      explanation = await aiService.interpretMetadataChange(
        metadata,
        'ValidationRule',
        name,
        settings
      );
    } else {
      // Fetch Formula Field metadata
      const formulaMetadata = await salesforceService.getFormulaFieldMetadata(
        orgId,
        name,
        objectName
      );

      if (!formulaMetadata) {
        return res.status(404).json({
          success: false,
          error: `Formula Field "${name}" not found on object "${objectName}"`,
        });
      }

      metadata = formulaMetadata;

      // Generate AI explanation
      explanation = await aiService.interpretMetadataChange(
        formulaMetadata,
        'FormulaField',
        `${objectName}.${name}`,
        settings
      );
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
    return res.status(500).json({
      success: false,
      error: errorMessage,
    });
  }
});

export default router;
