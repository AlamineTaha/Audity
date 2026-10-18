import crypto from 'crypto';
import { Router, Request, Response } from 'express';
import { resolveTenant, TenantResolution } from '../middleware/tenantAuth';
import { authService } from '../services/container';
import { TenantContext } from '../types';

const TOKEN_TTL_SEC = 3600;
const tokenKey = (token: string) => `mcp_token:${crypto.createHash('sha256').update(token).digest('hex')}`;

// Salesforce returns 15- or 18-char org ids; the first 15 chars are the case-sensitive id.
const sameOrg = (a: string, b: string) => a.slice(0, 15) === b.slice(0, 15);

function readClientCredentials(req: Request): { clientId?: string; clientSecret?: string } {
  const header = req.headers.authorization;
  if (header?.startsWith('Basic ')) {
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    const sep = decoded.indexOf(':');
    if (sep > 0) {
      return {
        clientId: decodeURIComponent(decoded.slice(0, sep)),
        clientSecret: decodeURIComponent(decoded.slice(sep + 1)),
      };
    }
  }
  return { clientId: req.body?.client_id, clientSecret: req.body?.client_secret };
}

const router = Router();

/**
 * OAuth 2.0 client-credentials token endpoint for MCP clients (e.g. the Agentforce API Catalog).
 * client_id = Salesforce org id, client_secret = the tenant API key issued at onboarding.
 */
router.post('/oauth/token', async (req: Request, res: Response) => {
  if (req.body?.grant_type !== 'client_credentials') {
    res.status(400).json({ error: 'unsupported_grant_type' });
    return;
  }
  const { clientId, clientSecret } = readClientCredentials(req);
  if (!clientId || !clientSecret) {
    res.status(401).json({ error: 'invalid_client' });
    return;
  }

  const result = await resolveTenant({ kind: 'apiKey', apiKey: clientSecret }, 'POST /oauth/token');
  if (!result.ok) {
    res.status(result.status === 401 ? 401 : result.status).json({
      error: result.status === 401 ? 'invalid_client' : 'temporarily_unavailable',
    });
    return;
  }
  if (!sameOrg(result.tenant.orgId, clientId)) {
    res.status(401).json({ error: 'invalid_client' });
    return;
  }

  const token = crypto.randomBytes(32).toString('base64url');
  try {
    await authService.setCachedValue(tokenKey(token), JSON.stringify(result.tenant), TOKEN_TTL_SEC);
  } catch (error) {
    console.error('[MCP OAuth] Token store failed:', error);
    res.status(503).json({ error: 'temporarily_unavailable' });
    return;
  }
  res.set('Cache-Control', 'no-store').json({ access_token: token, token_type: 'Bearer', expires_in: TOKEN_TTL_SEC });
});

/** Accepts an access token from /oauth/token, or a tenant API key directly (for desktop MCP clients). */
export async function authenticateBearer(req: Request): Promise<TenantResolution> {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return { ok: false, status: 401, error: 'Missing bearer token' };
  }
  const token = header.slice(7).trim();
  let cached: string | null;
  try {
    cached = await authService.getCachedValue(tokenKey(token));
  } catch (error) {
    console.error('[MCP OAuth] Token lookup failed:', error);
    return { ok: false, status: 503, error: 'Authentication backend temporarily unavailable' };
  }
  if (cached) {
    return { ok: true, tenant: JSON.parse(cached) as TenantContext };
  }
  return resolveTenant({ kind: 'apiKey', apiKey: token }, `${req.method} ${req.originalUrl}`);
}

export default router;
