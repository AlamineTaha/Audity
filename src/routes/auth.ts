/**
 * Authentication Routes
 * Handles OAuth 2.0 Web Server Flow for Salesforce.
 * On successful callback the caller receives a one-time API key.
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
 *       Redirects to Salesforce OAuth authorization page. After the user authorizes,
 *       Salesforce redirects back to /auth/callback with an authorization code.
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
 *       - in: query
 *         name: gcpProjectId
 *         schema:
 *           type: string
 *         description: GCP Project ID (required for ENTERPRISE billing mode)
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
 *       Handles the OAuth callback from Salesforce. Exchanges the authorization code
 *       for tokens, registers the tenant in PostgreSQL, and returns a one-time API key.
 *
 *       **Important:** Save the returned `apiKey` immediately — it is shown only once.
 *       Use it in the `X-API-Key` header for all subsequent API requests.
 *     tags:
 *       - Auth
 *     parameters:
 *       - in: query
 *         name: code
 *         required: true
 *         schema:
 *           type: string
 *         description: Authorization code from Salesforce
 *       - in: query
 *         name: state
 *         schema:
 *           type: string
 *         description: State parameter from authorization request
 *     responses:
 *       200:
 *         description: Organization successfully authenticated
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 orgId:
 *                   type: string
 *                 apiKey:
 *                   type: string
 *                   description: Your API key. Store it securely — it will not be shown again.
 *                 message:
 *                   type: string
 *       400:
 *         description: Bad request
 *       500:
 *         description: Internal server error
 */
router.get('/callback', async (req: Request, res: Response) => {
  try {
    console.log('[OAuth Callback] Received query params:', req.query);

    const code = req.query.code as string;
    const error = req.query.error as string | undefined;
    const errorDescription = req.query.error_description as string | undefined;
    const state = req.query.state as string | undefined;

    if (error) {
      console.error('[OAuth Callback] Salesforce error:', error, errorDescription);
      return res.status(400).json({
        error: `Salesforce OAuth error: ${error}`,
        errorDescription: errorDescription || 'No description provided',
        message: 'Please check your Connected App configuration and try again.',
      });
    }

    if (!code) {
      console.error('[OAuth Callback] No authorization code received');
      return res.status(400).json({
        error: 'Authorization code not provided',
        receivedParams: req.query,
        message:
          'Salesforce did not return an authorization code. Please check: ' +
          '1) Callback URL matches exactly in Connected App, ' +
          '2) You authorized the app, 3) Connected App is active.',
      });
    }

    let billingMode: 'PERSONAL' | 'ENTERPRISE' = 'PERSONAL';
    let gcpProjectId: string | undefined;

    if (state) {
      try {
        const stateData = JSON.parse(state);
        billingMode = stateData.billingMode || 'PERSONAL';
        gcpProjectId = stateData.gcpProjectId;
      } catch {
        // state is not JSON — ignore
      }
    }

    if (billingMode === 'ENTERPRISE' && !gcpProjectId) {
      return res.status(400).json({
        error: 'GCP Project ID is required for Enterprise billing mode',
      });
    }

    const { orgSettings, apiKey } = await authService.authorize(code, billingMode, gcpProjectId, state);

    return res.json({
      success: true,
      orgId: orgSettings.orgId,
      apiKey,
      message:
        'Organization successfully authenticated. ' +
        'Store your API key securely — it will not be shown again. ' +
        'Use it in the X-API-Key header for all subsequent requests.',
    });
  } catch (error) {
    console.error('OAuth callback error:', error);
    const errorMessage = error instanceof Error ? error.message : 'Authentication failed';
    return res.status(500).json({ error: errorMessage });
  }
});

export default router;

export { authService };
