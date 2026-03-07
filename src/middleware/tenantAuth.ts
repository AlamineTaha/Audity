/**
 * Tenant Authentication Middleware
 *
 * Validates the X-API-Key header, resolves the tenant from the database
 * (with a Redis cache layer), and attaches TenantContext to the request.
 */

import { Request, Response, NextFunction } from 'express';
import { DatabaseService } from '../services/databaseService';
import { SalesforceAuthService } from '../services/authService';
import { TenantContext, AuthenticatedRequest } from '../types';

const CACHE_PREFIX = 'tenant_ctx:';
const CACHE_TTL_SEC = 300; // 5 minutes

let dbService: DatabaseService | null = null;
let authServiceInstance: SalesforceAuthService | null = null;

export function initTenantAuth(db: DatabaseService, auth: SalesforceAuthService): void {
  dbService = db;
  authServiceInstance = auth;
}

export async function tenantAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!dbService || !authServiceInstance) {
    res.status(500).json({ error: 'Tenant authentication not initialized' });
    return;
  }

  const apiKey = req.headers['x-api-key'] as string | undefined;
  if (!apiKey) {
    res.status(401).json({
      error: 'Missing X-API-Key header',
      hint: 'Include your API key in the X-API-Key header. You receive an API key after completing OAuth at /auth/authorize.',
    });
    return;
  }

  try {
    const apiKeyHash = DatabaseService.hashApiKey(apiKey);

    // Try Redis cache first
    await authServiceInstance.connect();
    const cacheKey = `${CACHE_PREFIX}${apiKeyHash}`;
    const cached = await authServiceInstance.getCachedValue(cacheKey);
    if (cached) {
      (req as AuthenticatedRequest).tenant = JSON.parse(cached);
      next();
      return;
    }

    // Lookup in PostgreSQL
    const tenant = await dbService.getTenantByApiKeyHash(apiKeyHash);
    if (!tenant) {
      res.status(401).json({ error: 'Invalid API key' });
      return;
    }

    const ctx: TenantContext = {
      orgId: tenant.org_id,
      instanceUrl: tenant.instance_url,
      billingMode: tenant.billing_mode,
      gcpProjectId: tenant.gcp_project_id || undefined,
    };

    // Cache for subsequent requests
    await authServiceInstance.setCachedValue(cacheKey, JSON.stringify(ctx), CACHE_TTL_SEC);

    (req as AuthenticatedRequest).tenant = ctx;
    next();
  } catch (error) {
    console.error('[TenantAuth] Error resolving tenant:', error);
    res.status(500).json({ error: 'Tenant authentication failed' });
  }
}
