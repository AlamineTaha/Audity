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
const TENANT_LOOKUP_RETRIES = 2;
const TENANT_LOOKUP_BACKOFF_MS = 150;

let dbService: DatabaseService | null = null;
let authServiceInstance: SalesforceAuthService | null = null;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isInfrastructureError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const msg = error.message.toLowerCase();
  return (
    msg.includes('timeout') ||
    msg.includes('connection terminated') ||
    msg.includes('socket closed') ||
    msg.includes('econnreset') ||
    msg.includes('econnrefused') ||
    msg.includes('enotfound') ||
    msg.includes('redis') ||
    msg.includes('pg')
  );
}

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
    const requestPath = `${req.method} ${req.originalUrl}`;

    // Try Redis cache first
    const cacheKey = `${CACHE_PREFIX}${apiKeyHash}`;
    let cached: string | null = null;
    try {
      await authServiceInstance.connect();
      cached = await authServiceInstance.getCachedValue(cacheKey);
    } catch (redisError) {
      console.error(`[TenantAuth][REDIS] Cache read failed for ${requestPath}:`, redisError);
    }
    if (cached) {
      console.log(`[TenantAuth][CACHE_HIT] ${requestPath}`);
      (req as AuthenticatedRequest).tenant = JSON.parse(cached);
      next();
      return;
    }

    // Lookup in PostgreSQL (with retry/backoff for transient infrastructure failures)
    let tenant: Awaited<ReturnType<DatabaseService['getTenantByApiKeyHash']>> = null;
    let lastLookupError: unknown = null;
    for (let attempt = 0; attempt <= TENANT_LOOKUP_RETRIES; attempt++) {
      try {
        tenant = await dbService.getTenantByApiKeyHash(apiKeyHash);
        break;
      } catch (lookupError) {
        lastLookupError = lookupError;
        const retryable = isInfrastructureError(lookupError) && attempt < TENANT_LOOKUP_RETRIES;
        console.error(
          `[TenantAuth][DB] Tenant lookup failed (attempt ${attempt + 1}/${TENANT_LOOKUP_RETRIES + 1}) for ${requestPath}:`,
          lookupError
        );
        if (retryable) {
          await sleep(TENANT_LOOKUP_BACKOFF_MS * (attempt + 1));
          continue;
        }
        throw lookupError;
      }
    }

    if (!tenant) {
      if (lastLookupError && isInfrastructureError(lastLookupError)) {
        res.status(503).json({
          error: 'Authentication backend temporarily unavailable',
          category: 'db',
        });
        return;
      }
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
    try {
      await authServiceInstance.setCachedValue(cacheKey, JSON.stringify(ctx), CACHE_TTL_SEC);
    } catch (redisError) {
      console.error(`[TenantAuth][REDIS] Cache write failed for ${requestPath}:`, redisError);
    }

    (req as AuthenticatedRequest).tenant = ctx;
    console.log(`[TenantAuth][DB_HIT] ${requestPath} orgId=${ctx.orgId}`);
    next();
  } catch (error) {
    const requestPath = `${req.method} ${req.originalUrl}`;
    const backendCategory = isInfrastructureError(error) ? 'infrastructure' : 'unknown';
    console.error(`[TenantAuth][${backendCategory.toUpperCase()}] Error resolving tenant for ${requestPath}:`, error);
    res.status(isInfrastructureError(error) ? 503 : 500).json({
      error: isInfrastructureError(error)
        ? 'Authentication backend temporarily unavailable'
        : 'Tenant authentication failed',
      category: backendCategory,
    });
  }
}
