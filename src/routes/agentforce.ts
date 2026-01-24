/**
 * Agentforce Integration Routes
 * REST API endpoints for Salesforce Einstein Agent to query Flow changes
 */

import { Router, Request, Response } from 'express';
import { SalesforceService } from '../services/salesforceService';
import { AIService } from '../services/aiService';
import { SalesforceAuthService } from '../services/authService';
import { AnalyzeFlowRequest, AnalyzeFlowResponse } from '../types';

const router = Router();

/**
 * @swagger
 * /api/v1/analyze-flow:
 *   post:
 *     summary: Analyze Flow changes
 *     description: Fetches current and previous Flow versions, uses AI to analyze differences, and returns a summary
 *     tags:
 *       - Agentforce
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - flowName
 *               - orgId
 *             properties:
 *               flowName:
 *                 type: string
 *                 description: The API name of the Flow to analyze
 *                 example: "My_Flow"
 *               orgId:
 *                 type: string
 *                 description: The Salesforce Organization ID
 *                 example: "00D000000000000AAA"
 *     responses:
 *       200:
 *         description: Successful analysis
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 flowName:
 *                   type: string
 *                   example: "My_Flow"
 *                 summary:
 *                   type: string
 *                   example: "The Flow was updated to include a new decision element..."
 *                 changes:
 *                   type: array
 *                   items:
 *                     type: string
 *                   example: ["Added new decision element", "Modified field update logic"]
 *                 revertOptions:
 *                   type: object
 *                   description: Safe-revert options for Flow version management
 *                   properties:
 *                     summary:
 *                       type: string
 *                       description: Summary of changes detected
 *                       example: "5 change(s) detected today."
 *                     versionsToday:
 *                       type: array
 *                       description: List of version numbers modified today
 *                       items:
 *                         type: integer
 *                       example: [39, 38, 37, 36, 35]
 *                     recommendedStableVersion:
 *                       type: integer
 *                       nullable: true
 *                       description: Recommended stable version number before today's changes
 *                       example: 34
 *                     revertPrompt:
 *                       type: string
 *                       description: Prompt message for revert action
 *                       example: "Would you like to activate Version 34 (Last Stable), a specific version, or keep the current changes?"
 *       400:
 *         description: Bad request - missing required fields
 *       404:
 *         description: Flow not found
 *       500:
 *         description: Internal server error
 */
router.post('/analyze-flow', async (req: Request, res: Response) => {
  try {
    const { flowName, orgId }: AnalyzeFlowRequest = req.body;

    // Validate input
    if (!flowName || !orgId) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: flowName and orgId are required',
      } as AnalyzeFlowResponse);
    }

    // Initialize services
    const authService = new SalesforceAuthService();
    const salesforceService = new SalesforceService(authService);
    const aiService = new AIService();

    // Get org settings for billing mode
    const settings = await authService.getOrgSettings(orgId);
    if (!settings) {
      return res.status(404).json({
        success: false,
        error: `Organization settings not found for orgId: ${orgId}. Please authenticate the organization first by visiting /auth/authorize?billingMode=PERSONAL`,
      } as AnalyzeFlowResponse);
    }

    // Fetch Flow versions
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

    // Generate AI summary
    const diff = await aiService.generateSummary(
      versions.previous,
      versions.current,
      flowName,
      settings
    );

    // Get versions modified today for revert options
    const versionsToday = await salesforceService.getFlowVersionsInTimeWindow(orgId, flowName, 24);
    const versionNumbersToday = versionsToday.map(v => v.versionNumber);
    const recommendedStableVersion = await salesforceService.findLastStableVersion(orgId, flowName, 24);

    // Build revert prompt
    let revertPrompt = '';
    if (versionNumbersToday.length > 0) {
      if (recommendedStableVersion) {
        revertPrompt = `Would you like to activate Version ${recommendedStableVersion} (Last Stable), a specific version, or keep the current changes?`;
      } else {
        revertPrompt = `Would you like to activate a specific version or keep the current changes?`;
      }
    } else {
      revertPrompt = 'No changes detected today. No revert action needed.';
    }

    // Get dependency report
    let dependencies;
    try {
      dependencies = await salesforceService.getFlowDependencyReport(orgId, flowName);
    } catch (error) {
      console.error(`Error fetching dependency report for ${flowName}:`, error);
      // Don't fail the entire request if dependency check fails
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

    // Return response
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
    };

    res.json(response);
  } catch (error) {
    console.error('Error in analyze-flow endpoint:', error);
    const errorMessage = error instanceof Error ? error.message : 'Internal server error';
    res.status(500).json({
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
 *     description: Returns the health status of the API
 *     tags:
 *       - Agentforce
 *     responses:
 *       200:
 *         description: Service is healthy
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: string
 *                   example: "ok"
 *                 timestamp:
 *                   type: string
 *                   example: "2024-01-01T00:00:00.000Z"
 */
router.get('/health', (req: Request, res: Response) => {
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
 *     description: |
 *       Validates that OAuth environment variables are configured correctly.
 *       This endpoint does not require an authenticated org.
 *     tags:
 *       - Agentforce
 *     responses:
 *       200:
 *         description: OAuth configuration test results
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 config:
 *                   type: object
 *                   description: Masked configuration values
 *                 message:
 *                   type: string
 */
router.get('/test-oauth-config', (req: Request, res: Response) => {
  const config = {
    SF_CLIENT_ID: process.env.SF_CLIENT_ID ? '***' + process.env.SF_CLIENT_ID.slice(-4) : 'NOT SET',
    SF_CLIENT_SECRET: process.env.SF_CLIENT_SECRET ? '***SET***' : 'NOT SET',
    SF_REDIRECT_URI: process.env.SF_REDIRECT_URI || 'NOT SET',
    SF_LOGIN_URL: process.env.SF_LOGIN_URL || 'NOT SET',
    REDIS_HOST: process.env.REDIS_HOST || 'NOT SET',
    REDIS_PORT: process.env.REDIS_PORT || 'NOT SET',
  };

  const isValid = 
    process.env.SF_CLIENT_ID &&
    process.env.SF_CLIENT_SECRET &&
    process.env.SF_REDIRECT_URI &&
    process.env.SF_LOGIN_URL;

  res.json({
    success: !!isValid,
    config,
    message: isValid 
      ? 'OAuth configuration appears valid' 
      : 'Some OAuth configuration is missing',
  });
});

/**
 * @swagger
 * /api/v1/test-connection:
 *   post:
 *     summary: Test Salesforce org connection
 *     description: |
 *       Tests the connection to a Salesforce org, validates OAuth tokens,
 *       and returns detailed error information for debugging.
 *     tags:
 *       - Agentforce
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - orgId
 *             properties:
 *               orgId:
 *                 type: string
 *                 description: The Salesforce Organization ID to test
 *                 example: "00D000000000000AAA"
 *     responses:
 *       200:
 *         description: Connection test results
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 orgId:
 *                   type: string
 *                 tests:
 *                   type: object
 *                   properties:
 *                     orgSettingsFound:
 *                       type: boolean
 *                     tokenRefresh:
 *                       type: boolean
 *                     apiQuery:
 *                       type: boolean
 *                 userInfo:
 *                   type: object
 *                 errors:
 *                   type: array
 *                   items:
 *                     type: object
 *       400:
 *         description: Bad request - missing orgId
 *       404:
 *         description: Org not found
 *       500:
 *         description: Internal server error
 */
router.post('/test-connection', async (req: Request, res: Response) => {
  const { orgId } = req.body;
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
    if (!orgId) {
      return res.status(400).json({
        success: false,
        error: 'orgId is required',
      });
    }

    const authService = new SalesforceAuthService();
    await authService.connect();

    // Test 1: Check if org settings exist
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
      console.log(`[TEST] Org settings found for ${orgId}`);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      testResults.errors.push({
        step: 'orgSettingsFound',
        error: errorMsg,
        details: error,
      });
      console.error(`[TEST] Error fetching org settings:`, error);
    }

    // Test 2: Test token refresh
    try {
      const refreshedSettings = await authService.refreshSession(orgId);
      testResults.tests.tokenRefresh = true;
      console.log(`[TEST] Token refresh successful for ${orgId}`);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      testResults.errors.push({
        step: 'tokenRefresh',
        error: `Token refresh failed: ${errorMsg}`,
        details: error instanceof Error ? {
          name: error.name,
          message: error.message,
          stack: error.stack,
        } : error,
      });
      console.error(`[TEST] Token refresh error:`, error);
    }

    // Test 3: Test API query (get user info)
    try {
      const conn = await authService.getConnection(orgId);
      const userId = conn.userInfo?.id;
      
      if (!userId) {
        throw new Error('User ID not available in connection');
      }

      const userInfo = await conn.query(`SELECT Id, Name, Email, Username FROM User WHERE Id = '${userId}' LIMIT 1`);
      
      if (userInfo && userInfo.records && userInfo.records.length > 0) {
        testResults.tests.apiQuery = true;
        testResults.userInfo = {
          id: conn.userInfo?.id,
          organizationId: conn.userInfo?.organizationId,
          url: conn.userInfo?.url,
          user: userInfo.records[0],
        };
        console.log(`[TEST] API query successful for ${orgId}`);
      } else {
        throw new Error('No user info returned from query');
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      testResults.errors.push({
        step: 'apiQuery',
        error: `API query failed: ${errorMsg}`,
        details: error instanceof Error ? {
          name: error.name,
          message: error.message,
          stack: error.stack,
        } : error,
      });
      console.error(`[TEST] API query error:`, error);
    }

    // Determine overall success
    testResults.success = testResults.tests.orgSettingsFound && 
                          testResults.tests.tokenRefresh && 
                          testResults.tests.apiQuery;

    const statusCode = testResults.success ? 200 : 500;
    res.status(statusCode).json(testResults);

  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    testResults.errors.push({
      step: 'general',
      error: errorMsg,
      details: error instanceof Error ? {
        name: error.name,
        message: error.message,
        stack: error.stack,
      } : error,
    });
    console.error(`[TEST] General error:`, error);
    res.status(500).json(testResults);
  }
});

/**
 * @swagger
 * /api/v1/test-gemini:
 *   post:
 *     summary: Test Gemini API call
 *     description: |
 *       Tests the Gemini API call directly with different configurations.
 *       Useful for debugging API version and model name issues.
 *     tags:
 *       - Agentforce
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               prompt:
 *                 type: string
 *                 description: Test prompt to send to Gemini
 *                 example: "Say hello"
 *               apiVersion:
 *                 type: string
 *                 description: API version to test (v1 or v1beta)
 *                 example: "v1"
 *               model:
 *                 type: string
 *                 description: Model name to test
 *                 example: "gemini-1.5-flash"
 *     responses:
 *       200:
 *         description: Gemini API test results
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 url:
 *                   type: string
 *                 model:
 *                   type: string
 *                 apiVersion:
 *                   type: string
 *                 response:
 *                   type: string
 *                 error:
 *                   type: string
 */
router.post('/test-gemini', async (req: Request, res: Response) => {
  const { prompt = 'Say hello in one sentence', apiVersion = 'v1', model } = req.body;
  
  const aiService = new AIService();
  const testModel = model || process.env.GEMINI_MODEL || 'gemini-1.5-flash';
  const geminiApiKey = process.env.GEMINI_API_KEY || '';

  if (!geminiApiKey) {
    return res.status(400).json({
      success: false,
      error: 'GEMINI_API_KEY is not configured',
    });
  }

  // Test different configurations
  const testConfigs = [
    { apiVersion: 'v1', model: testModel },
    { apiVersion: 'v1beta', model: testModel },
    { apiVersion: 'v1', model: 'gemini-2.5-flash' },
    { apiVersion: 'v1beta', model: 'gemini-2.5-flash' },
    { apiVersion: 'v1', model: 'gemini-1.5-pro' },
    { apiVersion: 'v1beta', model: 'gemini-1.5-pro' },
  ];

  // If specific config provided, test only that
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
        {
          contents: [
            {
              parts: [
                {
                  text: prompt,
                },
              ],
            },
          ],
        },
        {
          headers: {
            'Content-Type': 'application/json',
          },
          timeout: 30000,
        }
      );

      const text = response.data?.candidates?.[0]?.content?.parts?.[0]?.text;
      
      results.push({
        success: true,
        url,
        apiVersion: config.apiVersion,
        model: config.model,
        response: text || 'No text in response',
        fullResponse: response.data,
      });
      
      // If one succeeds, return immediately
      if (text) {
        return res.json({
          success: true,
          workingConfig: {
            apiVersion: config.apiVersion,
            model: config.model,
          },
          url,
          response: text,
          allResults: results,
        });
      }
    } catch (error: any) {
      const errorData = error.response?.data || error.message;
      results.push({
        success: false,
        url,
        apiVersion: config.apiVersion,
        model: config.model,
        error: error.response?.status || 'Unknown',
        errorMessage: error.message,
        errorData,
      });
    }
  }

  // If we get here, all configs failed
  res.status(500).json({
    success: false,
    message: 'All Gemini API configurations failed',
    allResults: results,
  });
});

export default router;

