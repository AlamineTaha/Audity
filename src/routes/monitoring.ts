/**
 * Monitoring Routes
 * REST API endpoints for proactive monitoring and manual triggers
 */

import { Router, Request, Response } from 'express';
import { MonitorService } from '../services/monitorService';
import { SalesforceService } from '../services/salesforceService';
import { AIService } from '../services/aiService';
import { SlackService } from '../services/slackService';
import { SalesforceAuthService } from '../services/authService';

const router = Router();

// Initialize services (these will be reused across requests)
let monitorService: MonitorService | null = null;

function getMonitorService(): MonitorService {
  if (!monitorService) {
    const authService = new SalesforceAuthService();
    const salesforceService = new SalesforceService(authService);
    const aiService = new AIService();
    const slackService = new SlackService();
    monitorService = new MonitorService(
      salesforceService,
      aiService,
      slackService,
      authService
    );
  }
  return monitorService;
}

/**
 * @swagger
 * /api/v1/trigger-check:
 *   post:
 *     summary: Force Immediate Change Check
 *     description: Manually triggers the polling engine to check for Salesforce changes immediately, analyze them with AI, and send Slack alerts if issues are found.
 *     tags:
 *       - Monitoring
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
 *                   example: "Manual check initiated. Notifications will be sent if changes are found."
 *                 changesFound:
 *                   type: integer
 *                 errors:
 *                   type: array
 *                   items:
 *                     type: string
 */
router.post('/trigger-check', async (_req: Request, res: Response) => {
  try {
    const service = getMonitorService();
    const result = await service.runChangeCheck();

    res.json({
      success: result.success,
      message: result.success
        ? `Manual check completed. Found ${result.changesFound} change(s).`
        : 'Manual check completed with errors.',
      changesFound: result.changesFound,
      errors: result.errors,
    });
  } catch (error) {
    console.error('Error in trigger-check endpoint:', error);
    const errorMessage = error instanceof Error ? error.message : 'Internal server error';
    res.status(500).json({
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
 *     description: Retrieves a raw list of metadata changes (Flows, Permissions, Objects) from the Audit Trail.
 *     tags:
 *       - Monitoring
 *     parameters:
 *       - in: query
 *         name: hours
 *         schema:
 *           type: integer
 *           default: 24
 *         description: Lookback window in hours
 *       - in: query
 *         name: orgId
 *         schema:
 *           type: string
 *         description: Salesforce Organization ID (required)
 *     responses:
 *       200:
 *         description: List of recent changes
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
 *                 properties:
 *                   action:
 *                     type: string
 *                     example: "ChangedFlow"
 *                   user:
 *                     type: string
 *                     example: "Alice Smith"
 *                   section:
 *                     type: string
 *                     example: "Flow Management"
 *                   timestamp:
 *                     type: string
 *       400:
 *         description: Bad request - missing orgId
 *       500:
 *         description: Internal server error
 */
router.get('/recent-changes', async (req: Request, res: Response) => {
  try {
    const { orgId, hours } = req.query;

    if (!orgId || typeof orgId !== 'string') {
      return res.status(400).json({
        error: 'orgId query parameter is required',
      });
    }

    const hoursNum = hours ? parseInt(hours as string, 10) : 24;
    if (isNaN(hoursNum) || hoursNum < 1) {
      return res.status(400).json({
        error: 'hours must be a positive integer',
      });
    }

    const authService = new SalesforceAuthService();
    const salesforceService = new SalesforceService(authService);

    const auditRecords = await salesforceService.queryAuditTrailByHours(orgId, hoursNum);

    // Transform to the expected format
    const changes = auditRecords.map((record) => ({
      action: record.Action,
      user: record.CreatedBy.Name,
      section: record.Section,
      timestamp: record.CreatedDate,
      display: record.Display,
      id: record.Id,
    }));

    return res.json(changes);
  } catch (error) {
    console.error('Error in recent-changes endpoint:', error);
    const errorMessage = error instanceof Error ? error.message : 'Internal server error';
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
 *       Supported actions: Read, Create, Edit, Delete, ViewAll, ModifyAll.
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

export default router;
