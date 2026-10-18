/**
 * Tenant Authentication Middleware
 *
 * Resolves the tenant from either the X-API-Key header, or the Named Credential
 * headers (x-sfdc-org-id + x-auditdelta-secret), with a Redis cache layer,
 * and attaches TenantContext to the request.
 */

import crypto from 'crypto';
import { Request, Response, NextFunction } from 'express';
import { DatabaseService, TenantRow } from '../services/databaseService';
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

function sharedSecretMatches(provided: string): boolean {
  const expected = process.env.AUDITDELTA_SECRET;
  if (!expected) return false;
  const a = crypto.createHash('sha256').update(provided).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
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

  const db = dbService;
  const apiKey = req.headers['x-api-key'] as string | undefined;
  const sfOrgId = req.headers['x-sfdc-org-id'] as string | undefined;
  const sharedSecret = req.headers['x-auditdelta-secret'] as string | undefined;

  let cacheKey: string;
  let fetchTenant: () => Promise<TenantRow | null>;
  if (apiKey) {
    const apiKeyHash = DatabaseService.hashApiKey(apiKey);
    cacheKey = `${CACHE_PREFIX}${apiKeyHash}`;
    fetchTenant = () => db.getTenantByApiKeyHash(apiKeyHash);
  } else if (sfOrgId && sharedSecret) {
    if (!sharedSecretMatches(sharedSecret)) {
      res.status(401).json({ error: 'Invalid x-auditdelta-secret' });
      return;
    }
    cacheKey = `${CACHE_PREFIX}org:${sfOrgId}`;
    fetchTenant = () => db.getTenantByOrgId(sfOrgId);
  } else {
    res.status(401).json({
      error: 'Missing credentials',
      hint: 'Send X-API-Key (issued after OAuth at /auth/authorize), or x-sfdc-org-id + x-auditdelta-secret via the Salesforce Named Credential.',
    });
    return;
  }

  try {
    const requestPath = `${req.method} ${req.originalUrl}`;

    // Try Redis cache first
    let cached: string | null = null;
    try {
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
    let tenant: TenantRow | null = null;
    let lastLookupError: unknown = null;
    for (let attempt = 0; attempt <= TENANT_LOOKUP_RETRIES; attempt++) {
      try {
        tenant = await fetchTenant();
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
      res.status(401).json({ error: apiKey ? 'Invalid API key' : `Org ${sfOrgId} is not registered with AuditDelta` });
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
