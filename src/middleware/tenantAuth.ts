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

export type TenantCredential =
  | { kind: 'apiKey'; apiKey: string }
  | { kind: 'orgId'; orgId: string };

export type TenantResolution =
  | { ok: true; tenant: TenantContext }
  | { ok: false; status: 401 | 500 | 503; error: string };

/** Resolves a tenant from a credential the caller already authenticated (API key, or a verified org id). */
export async function resolveTenant(credential: TenantCredential, requestPath: string): Promise<TenantResolution> {
  if (!dbService || !authServiceInstance) {
    return { ok: false, status: 500, error: 'Tenant authentication not initialized' };
  }
  const db = dbService;
  const auth = authServiceInstance;

  let cacheKey: string;
  let fetchTenant: () => Promise<TenantRow | null>;
  if (credential.kind === 'apiKey') {
    const apiKeyHash = DatabaseService.hashApiKey(credential.apiKey);
    cacheKey = `${CACHE_PREFIX}${apiKeyHash}`;
    fetchTenant = () => db.getTenantByApiKeyHash(apiKeyHash);
  } else {
    cacheKey = `${CACHE_PREFIX}org:${credential.orgId}`;
    fetchTenant = () => db.getTenantByOrgId(credential.orgId);
  }

  try {
    let cached: string | null = null;
    try {
      cached = await auth.getCachedValue(cacheKey);
    } catch (redisError) {
      console.error(`[TenantAuth][REDIS] Cache read failed for ${requestPath}:`, redisError);
    }
    if (cached) {
      return { ok: true, tenant: JSON.parse(cached) };
    }

    // Lookup in PostgreSQL (with retry/backoff for transient infrastructure failures)
    let tenant: TenantRow | null = null;
    for (let attempt = 0; attempt <= TENANT_LOOKUP_RETRIES; attempt++) {
      try {
        tenant = await fetchTenant();
        break;
      } catch (lookupError) {
        console.error(
          `[TenantAuth][DB] Tenant lookup failed (attempt ${attempt + 1}/${TENANT_LOOKUP_RETRIES + 1}) for ${requestPath}:`,
          lookupError
        );
        if (isInfrastructureError(lookupError) && attempt < TENANT_LOOKUP_RETRIES) {
          await sleep(TENANT_LOOKUP_BACKOFF_MS * (attempt + 1));
          continue;
        }
        throw lookupError;
      }
    }

    if (!tenant) {
      return {
        ok: false,
        status: 401,
        error: credential.kind === 'apiKey' ? 'Invalid API key' : `Org ${credential.orgId} is not registered with AuditDelta`,
      };
    }

    const ctx: TenantContext = {
      orgId: tenant.org_id,
      instanceUrl: tenant.instance_url,
      billingMode: tenant.billing_mode,
      gcpProjectId: tenant.gcp_project_id || undefined,
    };

    try {
      await auth.setCachedValue(cacheKey, JSON.stringify(ctx), CACHE_TTL_SEC);
    } catch (redisError) {
      console.error(`[TenantAuth][REDIS] Cache write failed for ${requestPath}:`, redisError);
    }
    return { ok: true, tenant: ctx };
  } catch (error) {
    const infra = isInfrastructureError(error);
    console.error(`[TenantAuth][${infra ? 'INFRASTRUCTURE' : 'UNKNOWN'}] Error resolving tenant for ${requestPath}:`, error);
    return {
      ok: false,
      status: infra ? 503 : 500,
      error: infra ? 'Authentication backend temporarily unavailable' : 'Tenant authentication failed',
    };
  }
}

export async function tenantAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const apiKey = req.headers['x-api-key'] as string | undefined;
  const sfOrgId = req.headers['x-sfdc-org-id'] as string | undefined;
  const sharedSecret = req.headers['x-auditdelta-secret'] as string | undefined;

  let credential: TenantCredential;
  if (apiKey) {
    credential = { kind: 'apiKey', apiKey };
  } else if (sfOrgId && sharedSecret) {
    if (!sharedSecretMatches(sharedSecret)) {
      res.status(401).json({ error: 'Invalid x-auditdelta-secret' });
      return;
    }
    credential = { kind: 'orgId', orgId: sfOrgId };
  } else {
    res.status(401).json({
      error: 'Missing credentials',
      hint: 'Send X-API-Key (issued after OAuth at /auth/authorize), or x-sfdc-org-id + x-auditdelta-secret via the Salesforce Named Credential.',
    });
    return;
  }

  const result = await resolveTenant(credential, `${req.method} ${req.originalUrl}`);
  if (!result.ok) {
    res.status(result.status).json({ error: result.error });
    return;
  }
  (req as AuthenticatedRequest).tenant = result.tenant;
  next();
}
