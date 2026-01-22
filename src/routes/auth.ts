/**
 * Authentication Routes
 * Handles OAuth 2.0 Web Server Flow for Salesforce
 */

import { Router, Request, Response } from 'express';
import { SalesforceAuthService } from '../services/authService';

const router = Router();
const authService = new SalesforceAuthService();

/**
 * @swagger
 * /auth/authorize:
 *   get:
 *     summary: Initiate OAuth 2.0 authorization flow
 *     description: |
 *       Redirects to Salesforce OAuth authorization page. After user authorizes,
 *       Salesforce will redirect back to /auth/callback with an authorization code.
 *       
 *       **Billing Modes:**
 *       - PERSONAL: Uses Gemini API with API key (default)
 *       - ENTERPRISE: Uses Vertex AI with customer billing (requires gcpProjectId)
 *     tags:
 *       - Auth
 *     parameters:
 *       - in: query
 *         name: billingMode
 *         schema:
 *           type: string
 *           enum: [PERSONAL, ENTERPRISE]
 *           default: PERSONAL
 *         description: Billing mode for AI service
 *         example: PERSONAL
 *       - in: query
 *         name: gcpProjectId
 *         schema:
 *           type: string
 *         description: GCP Project ID (required for ENTERPRISE billing mode)
 *         example: my-gcp-project-id
 *       - in: query
 *         name: state
 *         schema:
 *           type: string
 *         description: Optional state parameter for OAuth flow
 *     responses:
 *       302:
 *         description: Redirects to Salesforce authorization page
 *       400:
 *         description: Bad request
 */
router.get('/authorize', async (req: Request, res: Response) => {
  try {
    const state = req.query.state as string | undefined;
    const billingMode = (req.query.billingMode as 'PERSONAL' | 'ENTERPRISE') || 'PERSONAL';
    const gcpProjectId = req.query.gcpProjectId as string | undefined;

    // Store billing mode and GCP project ID in session/state for callback
    // In production, use a proper session store or encrypted state parameter
    const stateParam = state || JSON.stringify({ billingMode, gcpProjectId });
    const authUrl = await authService.getAuthorizationUrl(stateParam);

    res.redirect(authUrl);
  } catch (error) {
    console.error('Error generating authorization URL:', error);
    const errorMessage = error instanceof Error ? error.message : 'Failed to generate authorization URL';
    res.status(500).json({ error: errorMessage });
  }
});

/**
 * @swagger
 * /auth/callback:
 *   get:
 *     summary: OAuth 2.0 callback handler
 *     description: |
 *       Handles the OAuth callback from Salesforce. This endpoint is called by Salesforce
 *       after user authorization. It exchanges the authorization code for access tokens
 *       and stores organization settings in Redis.
 *       
 *       **Note:** This endpoint is typically called by Salesforce, not directly by clients.
 *     tags:
 *       - Auth
 *     parameters:
 *       - in: query
 *         name: code
 *         required: true
 *         schema:
 *           type: string
 *         description: Authorization code from Salesforce
 *         example: aPrxrF8KvQ8XgL9jH5mN3pQ6rS7tU8vW9xY0zA1bC2dE3f
 *       - in: query
 *         name: state
 *         schema:
 *           type: string
 *         description: State parameter from authorization request (may contain billing mode info)
 *     responses:
 *       200:
 *         description: Organization successfully authenticated
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/AuthCallbackResponse'
 *       400:
 *         description: Bad request - missing authorization code or invalid parameters
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/AuthErrorResponse'
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/AuthErrorResponse'
 */
router.get('/callback', async (req: Request, res: Response) => {
  try {
    // Log all query parameters for debugging
    console.log('[OAuth Callback] Received query params:', req.query);
    
    const code = req.query.code as string;
    const error = req.query.error as string | undefined;
    const errorDescription = req.query.error_description as string | undefined;
    const state = req.query.state as string | undefined;

    // Check if Salesforce returned an error
    if (error) {
      console.error('[OAuth Callback] Salesforce error:', error, errorDescription);
      return res.status(400).json({ 
        error: `Salesforce OAuth error: ${error}`,
        errorDescription: errorDescription || 'No description provided',
        message: 'Please check your Connected App configuration and try again.'
      });
    }

    // Check if code is missing
    if (!code) {
      console.error('[OAuth Callback] No authorization code received');
      console.error('[OAuth Callback] Full query:', JSON.stringify(req.query, null, 2));
      return res.status(400).json({ 
        error: 'Authorization code not provided',
        receivedParams: req.query,
        message: 'Salesforce did not return an authorization code. Please check: 1) Callback URL matches exactly in Connected App, 2) You authorized the app, 3) Connected App is active.'
      });
    }

    // Parse state to get billing mode and GCP project ID
    let billingMode: 'PERSONAL' | 'ENTERPRISE' = 'PERSONAL';
    let gcpProjectId: string | undefined;

    if (state) {
      try {
        const stateData = JSON.parse(state);
        billingMode = stateData.billingMode || 'PERSONAL';
        gcpProjectId = stateData.gcpProjectId;
      } catch {
        // State is not JSON, ignore
      }
    }

    // Validate Enterprise mode requirements
    if (billingMode === 'ENTERPRISE' && !gcpProjectId) {
      return res.status(400).json({
        error: 'GCP Project ID is required for Enterprise billing mode',
      });
    }

    // Pass state to authorize for PKCE code_verifier lookup
    const orgSettings = await authService.authorize(code, billingMode, gcpProjectId, state);

    res.json({
      success: true,
      orgId: orgSettings.orgId,
      message: 'Organization successfully authenticated',
    });
  } catch (error) {
    console.error('OAuth callback error:', error);
    const errorMessage = error instanceof Error ? error.message : 'Authentication failed';
    res.status(500).json({ error: errorMessage });
  }
});

export default router;

