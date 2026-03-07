/**
 * Agentforce Integration Routes
 * REST API endpoints for Salesforce Einstein Agent to query Flow changes.
 *
 * All protected routes receive tenant context via the tenantAuth middleware.
 * The orgId is resolved from the X-API-Key header — never from request body/query.
 */

import { Router, Request, Response } from 'express';
import { SalesforceService } from '../services/salesforceService';
import { AIService } from '../services/aiService';
import { SalesforceAuthService } from '../services/authService';
import { AuthenticatedRequest, AnalyzeFlowResponse } from '../types';

const router = Router();

/**
 * @swagger
 * /api/v1/analyze-flow:
 *   post:
 *     summary: Analyze Flow changes
 *     description: Fetches current and previous Flow versions, uses AI to analyze differences, and returns a summary
 *     tags:
 *       - Agentforce
 *     security:
 *       - ApiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - flowName
 *             properties:
 *               flowName:
 *                 type: string
 *                 description: The API name of the Flow to analyze
 *                 example: "My_Flow"
 *     responses:
 *       200:
 *         description: Successful analysis
 *       400:
 *         description: Bad request - missing required fields
 *       401:
 *         description: Missing or invalid API key
 *       404:
 *         description: Flow not found
 *       500:
 *         description: Internal server error
 */
router.post('/analyze-flow', async (req: Request, res: Response) => {
  try {
    const { tenant } = req as AuthenticatedRequest;
    const orgId = tenant.orgId;
    const { flowName } = req.body;

    if (!flowName) {
      return res.status(400).json({
        success: false,
        error: 'Missing required field: flowName',
      } as AnalyzeFlowResponse);
    }

    const authService = new SalesforceAuthService();
    const salesforceService = new SalesforceService(authService);
    const aiService = new AIService();

    const settings = await authService.getOrgSettings(orgId);
    if (!settings) {
      return res.status(404).json({
        success: false,
        error: `Organization settings not found for this tenant. Please re-authenticate at /auth/authorize`,
      } as AnalyzeFlowResponse);
    }

    let versions;
    try {
      versions = await salesforceService.getFlowVersions(orgId, flowName);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      if (errorMessage.includes('not found')) {
        return res.status(404).json({
          success: false,
          flowName,
          error: `Flow not found: ${flowName}`,
        } as AnalyzeFlowResponse);
      }
      throw error;
    }

    const diff = await aiService.generateSummary(
      versions.previous,
      versions.current,
      flowName,
      settings
    );

    const versionsToday = await salesforceService.getFlowVersionsInTimeWindow(orgId, flowName, 24);
    const versionNumbersToday = versionsToday.map(v => v.versionNumber);
    const recommendedStableVersion = await salesforceService.findLastStableVersion(orgId, flowName, 24);

    let revertPrompt = '';
    if (versionNumbersToday.length > 0) {
      revertPrompt = recommendedStableVersion
        ? `Would you like to activate Version ${recommendedStableVersion} (Last Stable), a specific version, or keep the current changes?`
        : `Would you like to activate a specific version or keep the current changes?`;
    } else {
      revertPrompt = 'No changes detected today. No revert action needed.';
    }

    let dependencies;
    try {
      dependencies = await salesforceService.getFlowDependencyReport(orgId, flowName);
    } catch (error) {
      console.error(`Error fetching dependency report for ${flowName}:`, error);
      dependencies = {
        reportedDependencies: [],
        uiDependencies: { buttons: [], quickActions: [] },
        subflowDependencies: [],
        securityNote: 'Dependency analysis could not be completed. Error occurred during metadata query.',
        limitations: [
          'Analysis limited to Metadata (Subflows/Buttons). External callers (Apex/LWC) were not scanned.',
          'Dependency analysis could not be completed due to an error. Please verify manually.',
        ],
      };
    }

    let revertImpact;
    if (recommendedStableVersion) {
      try {
        revertImpact = await salesforceService.checkRevertImpact(orgId, flowName, recommendedStableVersion);
      } catch (error) {
        console.error(`Error checking revert impact for ${flowName}:`, error);
        revertImpact = {
          warnings: ['Could not analyze revert impact. Please verify manually before reverting.'],
          activeSessions: 0,
          canRevert: false,
        };
      }
    } else {
      revertImpact = { warnings: [], activeSessions: 0, canRevert: true };
    }

    let riskAnalysis;
    try {
      const flowMetadata = await salesforceService.getFlowMetadata(orgId, flowName);
      if (flowMetadata) {
        const metadataStr = JSON.stringify(flowMetadata).toLowerCase();
        const hasPII = /(ssn|social|credit|card|password|pin|salary|wage|compensation)/i.test(metadataStr);
        const hasModifyAll = /modifyall|viewall/i.test(metadataStr);

        if (hasModifyAll) {
          riskAnalysis = {
            riskLevel: 'CRITICAL' as const,
            riskReason: 'Flow contains ModifyAll or ViewAll operations which grant access to all records regardless of sharing rules.',
          };
        } else if (hasPII) {
          riskAnalysis = {
            riskLevel: 'HIGH' as const,
            riskReason: 'Flow accesses PII (Personally Identifiable Information) fields. Ensure proper security controls are in place.',
          };
        } else {
          riskAnalysis = {
            riskLevel: 'LOW' as const,
            riskReason: 'No high-risk operations detected in Flow metadata.',
          };
        }
      }
    } catch (error) {
      console.error(`Error analyzing Flow risk:`, error);
      riskAnalysis = {
        riskLevel: 'MEDIUM' as const,
        riskReason: 'Could not complete risk analysis. Please verify manually.',
      };
    }

    const response: AnalyzeFlowResponse = {
      success: true,
      flowName: diff.flowName,
      summary: diff.summary,
      changes: diff.changes,
      revertOptions: {
        summary: `${versionNumbersToday.length} change(s) detected today.`,
        versionsToday: versionNumbersToday,
        recommendedStableVersion,
        revertPrompt,
      },
      dependencies,
      riskAnalysis,
      revertImpact,
    };

    return res.json(response);
  } catch (error) {
    console.error('Error in analyze-flow endpoint:', error);
    const errorMessage = error instanceof Error ? error.message : 'Internal server error';
    return res.status(500).json({
      success: false,
      error: errorMessage,
    } as AnalyzeFlowResponse);
  }
});

/**
 * @swagger
 * /api/v1/health:
 *   get:
 *     summary: Health check endpoint
 *     description: Returns the health status of the API (no auth required)
 *     tags:
 *       - Agentforce
 *     responses:
 *       200:
 *         description: Service is healthy
 */
router.get('/health', (_req: Request, res: Response) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
  });
});

/**
 * @swagger
 * /api/v1/test-oauth-config:
 *   get:
 *     summary: Test OAuth configuration
 *     description: Validates that OAuth environment variables are configured correctly. No auth required.
 *     tags:
 *       - Agentforce
 *     responses:
 *       200:
 *         description: OAuth configuration test results
 */
router.get('/test-oauth-config', (_req: Request, res: Response) => {
  const config = {
    SF_CLIENT_ID: process.env.SF_CLIENT_ID ? '***' + process.env.SF_CLIENT_ID.slice(-4) : 'NOT SET',
    SF_CLIENT_SECRET: process.env.SF_CLIENT_SECRET ? '***SET***' : 'NOT SET',
    SF_REDIRECT_URI: process.env.SF_REDIRECT_URI || 'NOT SET',
    SF_LOGIN_URL: process.env.SF_LOGIN_URL || 'NOT SET',
    DATABASE_URL: process.env.DATABASE_URL ? '***SET***' : 'NOT SET',
    REDIS_HOST: process.env.REDIS_HOST || 'NOT SET',
  };

  const isValid =
    process.env.SF_CLIENT_ID &&
    process.env.SF_CLIENT_SECRET &&
    process.env.SF_REDIRECT_URI &&
    process.env.SF_LOGIN_URL &&
    process.env.DATABASE_URL;

  res.json({
    success: !!isValid,
    config,
    message: isValid
      ? 'OAuth and database configuration appears valid'
      : 'Some configuration is missing',
  });
});

/**
 * @swagger
 * /api/v1/test-connection:
 *   post:
 *     summary: Test Salesforce org connection
 *     description: Tests the connection to the tenant's Salesforce org, validates OAuth tokens, and returns detailed error information.
 *     tags:
 *       - Agentforce
 *     security:
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: Connection test results
 *       401:
 *         description: Missing or invalid API key
 *       500:
 *         description: Internal server error
 */
router.post('/test-connection', async (req: Request, res: Response) => {
  const { tenant } = req as AuthenticatedRequest;
  const orgId = tenant.orgId;

  const testResults = {
    success: false,
    orgId,
    tests: {
      orgSettingsFound: false,
      tokenRefresh: false,
      apiQuery: false,
    },
    userInfo: null as any,
    errors: [] as Array<{ step: string; error: string; details?: any }>,
  };

  try {
    const authService = new SalesforceAuthService();
    await authService.connect();

    try {
      const settings = await authService.getOrgSettings(orgId);
      if (!settings) {
        testResults.errors.push({
          step: 'orgSettingsFound',
          error: `Organization settings not found for orgId: ${orgId}`,
        });
        return res.status(404).json(testResults);
      }
      testResults.tests.orgSettingsFound = true;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      testResults.errors.push({ step: 'orgSettingsFound', error: errorMsg });
    }

    try {
      await authService.refreshSession(orgId);
      testResults.tests.tokenRefresh = true;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      testResults.errors.push({ step: 'tokenRefresh', error: `Token refresh failed: ${errorMsg}` });
    }

    try {
      const conn = await authService.getConnection(orgId);
      const userId = conn.userInfo?.id;
      if (!userId) throw new Error('User ID not available in connection');

      const userInfo = await conn.query(`SELECT Id, Name, Email, Username FROM User WHERE Id = '${userId}' LIMIT 1`);
      if (userInfo?.records?.length) {
        testResults.tests.apiQuery = true;
        testResults.userInfo = {
          id: conn.userInfo?.id,
          organizationId: conn.userInfo?.organizationId,
          url: conn.userInfo?.url,
          user: userInfo.records[0],
        };
      } else {
        throw new Error('No user info returned from query');
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      testResults.errors.push({ step: 'apiQuery', error: `API query failed: ${errorMsg}` });
    }

    testResults.success =
      testResults.tests.orgSettingsFound &&
      testResults.tests.tokenRefresh &&
      testResults.tests.apiQuery;

    return res.status(testResults.success ? 200 : 500).json(testResults);
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    testResults.errors.push({ step: 'general', error: errorMsg });
    return res.status(500).json(testResults);
  }
});

/**
 * @swagger
 * /api/v1/test-gemini:
 *   post:
 *     summary: Test Gemini API call
 *     description: Tests the Gemini API directly with different configurations. No org auth required.
 *     tags:
 *       - Agentforce
 */
router.post('/test-gemini', async (req: Request, res: Response) => {
  const { prompt = 'Say hello in one sentence', apiVersion = 'v1', model } = req.body;
  const testModel = model || process.env.GEMINI_MODEL || 'gemini-1.5-flash';
  const geminiApiKey = process.env.GEMINI_API_KEY || '';

  if (!geminiApiKey) {
    return res.status(400).json({ success: false, error: 'GEMINI_API_KEY is not configured' });
  }

  const testConfigs = [
    { apiVersion: 'v1', model: testModel },
    { apiVersion: 'v1beta', model: testModel },
    { apiVersion: 'v1', model: 'gemini-2.5-flash' },
    { apiVersion: 'v1beta', model: 'gemini-2.5-flash' },
    { apiVersion: 'v1', model: 'gemini-1.5-pro' },
    { apiVersion: 'v1beta', model: 'gemini-1.5-pro' },
  ];

  if (apiVersion && model) {
    testConfigs.length = 0;
    testConfigs.push({ apiVersion, model });
  }

  const results = [];

  for (const config of testConfigs) {
    const url = `https://generativelanguage.googleapis.com/${config.apiVersion}/models/${config.model}:generateContent?key=${geminiApiKey}`;
    try {
      const axios = require('axios');
      const response = await axios.post(
        url,
        { contents: [{ parts: [{ text: prompt }] }] },
        { headers: { 'Content-Type': 'application/json' }, timeout: 30000 }
      );
      const text = response.data?.candidates?.[0]?.content?.parts?.[0]?.text;
      results.push({ success: true, url, apiVersion: config.apiVersion, model: config.model, response: text || 'No text', fullResponse: response.data });
      if (text) {
        return res.json({
          success: true,
          workingConfig: { apiVersion: config.apiVersion, model: config.model },
          url,
          response: text,
          allResults: results,
        });
      }
    } catch (error: any) {
      results.push({
        success: false,
        url,
        apiVersion: config.apiVersion,
        model: config.model,
        error: error.response?.status || 'Unknown',
        errorMessage: error.message,
        errorData: error.response?.data || error.message,
      });
    }
  }

  return res.status(500).json({ success: false, message: 'All Gemini API configurations failed', allResults: results });
});

/**
 * @swagger
 * /api/v1/flows/check-revert-impact:
 *   post:
 *     summary: Check revert impact before activating a Flow version
 *     tags:
 *       - Flows
 *     security:
 *       - ApiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - flowApiName
 *               - targetVersionNumber
 *             properties:
 *               flowApiName:
 *                 type: string
 *               targetVersionNumber:
 *                 type: integer
 */
router.post('/flows/check-revert-impact', async (req: Request, res: Response) => {
  try {
    const { tenant } = req as AuthenticatedRequest;
    const orgId = tenant.orgId;
    const flowApiName = req.query.flowApiName ?? req.body.flowApiName;
    const targetVersionNumber = req.query.targetVersionNumber ?? req.body.targetVersionNumber;

    if (!flowApiName || targetVersionNumber === undefined) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: flowApiName and targetVersionNumber are required',
      });
    }

    const authService = new SalesforceAuthService();
    const salesforceService = new SalesforceService(authService);

    const impact = await salesforceService.checkRevertImpact(orgId, flowApiName, targetVersionNumber);

    return res.json({
      success: true,
      warnings: impact.warnings,
      activeSessions: impact.activeSessions,
      canRevert: impact.canRevert,
      note: impact.activeSessions > 0
        ? `Note: Reverting will affect approximately ${impact.activeSessions} active flow interviews currently in progress.`
        : undefined,
    });
  } catch (error) {
    console.error('Error in check-revert-impact endpoint:', error);
    const errorMessage = error instanceof Error ? error.message : 'Internal server error';
    if (errorMessage.includes('not found')) {
      return res.status(404).json({ success: false, error: errorMessage });
    }
    return res.status(500).json({ success: false, error: errorMessage });
  }
});

/**
 * @swagger
 * /api/v1/flows/activate-version:
 *   post:
 *     summary: Activate a specific Flow version (Safe-Revert)
 *     tags:
 *       - Flows
 *     security:
 *       - ApiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - flowApiName
 *               - targetVersionNumber
 *             properties:
 *               flowApiName:
 *                 type: string
 *               targetVersionNumber:
 *                 type: integer
 */
router.post('/flows/activate-version', async (req: Request, res: Response) => {
  try {
    const { tenant } = req as AuthenticatedRequest;
    const orgId = tenant.orgId;
    const flowApiName = req.query.flowApiName ?? req.body.flowApiName;
    const targetVersionNumber = req.query.targetVersionNumber ?? req.body.targetVersionNumber;

    if (!flowApiName || targetVersionNumber === undefined) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: flowApiName and targetVersionNumber are required',
      });
    }

    const authService = new SalesforceAuthService();
    const salesforceService = new SalesforceService(authService);

    const result = await salesforceService.activateSpecificVersion(orgId, flowApiName, targetVersionNumber);

    return res.json({
      success: result.success,
      message: result.message,
      previousActiveVersion: result.previousActiveVersion,
      newActiveVersion: result.newActiveVersion,
      warnings: result.warnings,
    });
  } catch (error) {
    console.error('Error in activate-version endpoint:', error);
    const errorMessage = error instanceof Error ? error.message : 'Internal server error';
    if (errorMessage.includes('not found')) {
      return res.status(404).json({ success: false, error: errorMessage });
    }
    return res.status(500).json({ success: false, error: errorMessage });
  }
});

/**
 * @swagger
 * /api/v1/flows/revert-today:
 *   post:
 *     summary: Batch revert all changes made today
 *     tags:
 *       - Flows
 *     security:
 *       - ApiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - flowApiName
 *             properties:
 *               flowApiName:
 *                 type: string
 *               hours:
 *                 type: integer
 *                 default: 24
 */
router.post('/flows/revert-today', async (req: Request, res: Response) => {
  try {
    const { tenant } = req as AuthenticatedRequest;
    const orgId = tenant.orgId;
    const { flowApiName, hours = 24 } = req.body;

    if (!flowApiName) {
      return res.status(400).json({
        success: false,
        error: 'Missing required field: flowApiName',
      });
    }

    const authService = new SalesforceAuthService();
    const salesforceService = new SalesforceService(authService);

    const result = await salesforceService.batchRevertTodayChanges(orgId, flowApiName, hours);

    return res.json({
      success: result.success,
      message: result.message,
      stableVersion: result.stableVersion,
      previousActiveVersion: result.previousActiveVersion,
      warnings: result.warnings,
    });
  } catch (error) {
    console.error('Error in revert-today endpoint:', error);
    const errorMessage = error instanceof Error ? error.message : 'Internal server error';
    if (errorMessage.includes('not found')) {
      return res.status(404).json({ success: false, error: errorMessage });
    }
    return res.status(500).json({ success: false, error: errorMessage });
  }
});

/**
 * @swagger
 * /api/v1/flows/versions:
 *   get:
 *     summary: Get Flow version history within a time window
 *     tags:
 *       - Flows
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: query
 *         name: flowApiName
 *         required: true
 *         schema:
 *           type: string
 *       - in: query
 *         name: hours
 *         schema:
 *           type: integer
 *           default: 24
 */
router.get('/flows/versions', async (req: Request, res: Response) => {
  try {
    const { tenant } = req as AuthenticatedRequest;
    const orgId = tenant.orgId;
    const { flowApiName, hours } = req.query;

    if (!flowApiName) {
      return res.status(400).json({
        success: false,
        error: 'Missing required query parameter: flowApiName',
      });
    }

    const authService = new SalesforceAuthService();
    const salesforceService = new SalesforceService(authService);

    const hoursNum = hours ? parseInt(hours as string, 10) : 24;
    const versions = await salesforceService.getFlowVersionsInTimeWindow(
      orgId,
      flowApiName as string,
      hoursNum
    );

    return res.json({
      success: true,
      flowApiName,
      versions,
      timeWindow: `${hoursNum} hours`,
    });
  } catch (error) {
    console.error('Error in versions endpoint:', error);
    const errorMessage = error instanceof Error ? error.message : 'Internal server error';
    if (errorMessage.includes('not found')) {
      return res.status(404).json({ success: false, error: errorMessage });
    }
    return res.status(500).json({ success: false, error: errorMessage });
  }
});

export default router;
