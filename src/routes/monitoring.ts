/**
 * Monitoring Routes
 * REST API endpoints for proactive monitoring and manual triggers.
 *
 * Protected routes receive tenant context via the tenantAuth middleware.
 * The orgId is resolved from the X-API-Key header — never from request body/query.
 */

import { Router, Request, Response } from 'express';
import { authService } from '../services/container';
import { AuthenticatedRequest } from '../types';
import { toolRoute } from '../tools/rest';
import { runChangeCheckTool, getRecentChangesTool } from '../tools/changes';
import { analyzePermissionTool, findPermissionSourcesTool } from '../tools/permissions';
import { explainMetadataTool, analyzeValidationRulesTool, explainValidationRulesTool } from '../tools/metadata';
import { compareFlowVersionsTool } from '../tools/flowCompare';

const router = Router();

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
 * Clear the calling tenant's audit_processed dedup cache (for re-testing).
 */
router.post('/clear-audit-cache', async (req: Request, res: Response) => {
  try {
    const { tenant } = req as AuthenticatedRequest;
    const count = await authService.cleanupAuditProcessedKeys(tenant.orgId);
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
 *     description: Manually triggers the polling engine to check the calling tenant's org for changes.
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
router.post('/trigger-check', toolRoute(runChangeCheckTool));

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
router.get('/recent-changes', toolRoute(getRecentChangesTool));

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
router.post('/analyze-permission', toolRoute(analyzePermissionTool));

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
router.post('/find-permission-sources', toolRoute(findPermissionSourcesTool));

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
router.post('/explain-metadata', toolRoute(explainMetadataTool));

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
router.post('/analyze-validation-rules', toolRoute(analyzeValidationRulesTool));

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
router.post('/explain-validation-rules', toolRoute(explainValidationRulesTool));

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
router.post('/compare-flow-versions', toolRoute(compareFlowVersionsTool));

export default router;
