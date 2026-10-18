/**
 * Agentforce Integration Routes
 * REST API endpoints for Salesforce Einstein Agent to query Flow changes.
 *
 * All protected routes receive tenant context via the tenantAuth middleware.
 * The orgId is resolved from the X-API-Key header — never from request body/query.
 */

import { Router, Request, Response } from 'express';
import { authService } from '../services/container';
import { AuthenticatedRequest } from '../types';
import { toolRoute } from '../tools/rest';
import {
  analyzeFlowChangesTool,
  checkFlowRevertImpactTool,
  activateFlowVersionTool,
  revertFlowTodayTool,
  listFlowVersionsTool,
} from '../tools/flows';
import { generateAuditReportTool } from '../tools/reports';

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
router.post('/analyze-flow', toolRoute(analyzeFlowChangesTool));

/**
 * @swagger
 * /api/v1/health:
 *   get:
 *     summary: Health check endpoint
 *     description: Returns the health status of the API (no auth required)
 *     tags:
 *       - Agentforce
 *     security: []
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
 *     description: Validates that OAuth environment variables are configured correctly. Requires ENABLE_DEBUG_ROUTES=true.
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
 *     description: Tests the Gemini API directly with different configurations. Requires ENABLE_DEBUG_ROUTES=true.
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
router.post('/flows/check-revert-impact', toolRoute(checkFlowRevertImpactTool));

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
router.post('/flows/activate-version', toolRoute(activateFlowVersionTool));

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
router.post('/flows/revert-today', toolRoute(revertFlowTodayTool));

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
router.get('/flows/versions', toolRoute(listFlowVersionsTool));

/**
 * @swagger
 * /api/v1/generate-audit-report:
 *   post:
 *     summary: Generate Audit Report PDF
 *     description: |
 *       Queries the Setup Audit Trail for a given process type and time window,
 *       enriches each entry with an AI explanation, and returns a downloadable PDF report.
 *       Designed for Agentforce to provide on-demand audit documentation.
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
 *               - processType
 *               - hours
 *             properties:
 *               processType:
 *                 type: string
 *                 enum: [Flow, Permission, Layout, ValidationRule, CustomField, Object, All]
 *                 description: The category of metadata changes to include in the report
 *                 example: "Flow"
 *               hours:
 *                 type: integer
 *                 minimum: 1
 *                 maximum: 168
 *                 description: Lookback window in hours (1-168)
 *                 example: 24
 *     responses:
 *       200:
 *         description: Report generated — returns a download link
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 displayText:
 *                   type: string
 *                 downloadUrl:
 *                   type: string
 *       400:
 *         description: Bad request - missing or invalid parameters
 *       404:
 *         description: Organization not found
 *       500:
 *         description: Internal server error
 */
router.post('/generate-audit-report', toolRoute(generateAuditReportTool));

export default router;
