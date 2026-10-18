/**
 * Authentication Routes — Salesforce OAuth 2.0 Web Server flow with PKCE.
 */

import { Router, Request, Response } from 'express';
import { authService } from '../services/container';
import { OAuthStateError } from '../services/authService';
import { onSalesforceConnectedFromSlack } from '../slack/app';

const router = Router();

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));

function page(title: string, body: string): string {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>body{font-family:-apple-system,Segoe UI,sans-serif;max-width:720px;margin:48px auto;padding:0 16px;color:#1f2937}
code,pre{background:#f3f4f6;border-radius:6px;padding:2px 6px;word-break:break-all}pre{padding:12px;white-space:pre-wrap}
h1{font-size:22px}h2{font-size:16px;margin-top:28px}.warn{color:#b45309}</style></head><body>${body}</body></html>`;
}

function wantsHtml(req: Request): boolean {
  return Boolean(req.accepts(['html', 'json']) === 'html');
}

/**
 * @swagger
 * /auth/authorize:
 *   get:
 *     summary: Start Salesforce OAuth (open in a browser tab)
 *     description: Redirects to Salesforce login. Use `loginUrl=sandbox` for sandboxes or a My Domain URL.
 *     tags:
 *       - Auth
 *     security: []
 *     parameters:
 *       - in: query
 *         name: loginUrl
 *         schema:
 *           type: string
 *         description: '"sandbox", "production", or https://yourdomain.my.salesforce.com'
 *       - in: query
 *         name: billingMode
 *         schema:
 *           type: string
 *           enum: [PERSONAL, ENTERPRISE]
 *       - in: query
 *         name: gcpProjectId
 *         schema:
 *           type: string
 *     responses:
 *       302:
 *         description: Redirect to Salesforce login
 */
router.get('/authorize', async (req: Request, res: Response) => {
  try {
    const billingMode = req.query.billingMode === 'ENTERPRISE' ? 'ENTERPRISE' : 'PERSONAL';
    const gcpProjectId = typeof req.query.gcpProjectId === 'string' ? req.query.gcpProjectId : undefined;
    if (billingMode === 'ENTERPRISE' && !gcpProjectId) {
      res.status(400).json({ error: 'gcpProjectId is required for ENTERPRISE billing mode' });
      return;
    }
    const authUrl = await authService.startAuthorization({
      loginUrl: typeof req.query.loginUrl === 'string' ? req.query.loginUrl : undefined,
      billingMode,
      gcpProjectId,
    });
    res.redirect(authUrl);
  } catch (error) {
    console.error('[OAuth] Failed to start authorization:', error);
    res.status(400).json({ error: error instanceof Error ? error.message : 'Failed to start authorization' });
  }
});

/**
 * @swagger
 * /auth/callback:
 *   get:
 *     summary: OAuth callback (Salesforce redirects here)
 *     description: Exchanges the code, registers the org, and shows the tenant API key once.
 *     tags:
 *       - Auth
 *     security: []
 *     responses:
 *       200:
 *         description: Org connected (HTML for browsers, JSON otherwise)
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/AuthCallbackResponse'
 *       400:
 *         description: OAuth error or expired state
 */
router.get('/callback', async (req: Request, res: Response) => {
  const error = typeof req.query.error === 'string' ? req.query.error : undefined;
  const code = typeof req.query.code === 'string' ? req.query.code : undefined;
  const state = typeof req.query.state === 'string' ? req.query.state : undefined;

  const fail = (status: number, message: string) => {
    if (wantsHtml(req)) {
      res.status(status).send(page('Connection failed', `<h1>Connection failed</h1><p>${escapeHtml(message)}</p>`));
    } else {
      res.status(status).json({ error: message });
    }
  };

  if (error) {
    const description = typeof req.query.error_description === 'string' ? req.query.error_description : '';
    fail(400, `Salesforce returned "${error}". ${description}`);
    return;
  }
  if (!code || !state) {
    fail(400, 'Missing authorization code or state. Start again from /auth/authorize or /auditdelta connect.');
    return;
  }

  try {
    const { orgSettings, apiKey, slackLink } = await authService.completeAuthorization(code, state);
    let slackNote = '';
    if (slackLink) {
      try {
        await onSalesforceConnectedFromSlack(slackLink, orgSettings.orgId);
        slackNote = 'Your Slack workspace is linked — head back to Slack.';
      } catch (slackError) {
        console.error('[OAuth] Slack link failed:', slackError);
        slackNote = 'The org is connected, but linking it to Slack failed. Run /auditdelta connect again.';
      }
    }

    const base = process.env.API_BASE_URL || `${req.protocol}://${req.get('host')}`;
    if (!wantsHtml(req)) {
      res.json({ success: true, orgId: orgSettings.orgId, apiKey, slack: slackNote || undefined });
      return;
    }
    res.send(page('Salesforce connected', `
<h1>Salesforce org connected</h1>
<p>Org <code>${escapeHtml(orgSettings.orgId)}</code> (${escapeHtml(orgSettings.instanceUrl)}) is now monitored by AuditDelta.</p>
${slackNote ? `<p><strong>${escapeHtml(slackNote)}</strong></p>` : ''}
<h2>API key</h2>
<p class="warn">Shown once. Store it in a secret manager. Re-connecting the org issues a new key.</p>
<pre>${escapeHtml(apiKey)}</pre>
<h2>Agentforce / MCP clients</h2>
<p>Setup → API Catalog → MCP Servers → Import External MCP Server:</p>
<pre>MCP server URL:   ${escapeHtml(base)}/mcp
Token URL:        ${escapeHtml(base)}/oauth/token
Client ID:        ${escapeHtml(orgSettings.orgId)}
Client Secret:    (the API key above)</pre>
<p>Desktop MCP clients can send the API key directly as <code>Authorization: Bearer &lt;API key&gt;</code>.</p>`));
  } catch (err) {
    console.error('[OAuth] Callback failed:', err);
    fail(err instanceof OAuthStateError ? 400 : 500, err instanceof Error ? err.message : 'Authentication failed');
  }
});

export default router;
