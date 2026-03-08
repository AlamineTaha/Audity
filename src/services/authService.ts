/**
 * Salesforce Authentication Service
 *
 * Handles OAuth 2.0 Web Server Flow, token management, and deduplication.
 *
 * Persistent storage: PostgreSQL via DatabaseService (tenants table).
 * Cache / ephemeral data: Redis (PKCE, dedup keys, tenant-context cache).
 */

import * as jsforce from 'jsforce';
import { createClient, RedisClientType } from 'redis';
import * as crypto from 'crypto';
import { OrgSettings } from '../types';
import { DatabaseService } from './databaseService';

export class SalesforceAuthService {
  private redisClient: RedisClientType;
  private clientId: string;
  private clientSecret: string;
  private redirectUri: string;
  private loginUrl: string;
  private db: DatabaseService | null = null;

  constructor() {
    this.clientId = process.env.SF_CLIENT_ID || '';
    this.clientSecret = process.env.SF_CLIENT_SECRET || '';
    this.redirectUri = process.env.SF_REDIRECT_URI || '';
    this.loginUrl = process.env.SF_LOGIN_URL || 'https://login.salesforce.com';

    const redisUrl = process.env.REDIS_URL;
    if (redisUrl) {
      this.redisClient = createClient({
        url: redisUrl,
        socket: {
          tls: redisUrl.startsWith('rediss://'),
          rejectUnauthorized: false,
          reconnectStrategy: (retries) => Math.min(retries * 50, 500),
        },
      });
    } else {
      this.redisClient = createClient({
        socket: {
          host: process.env.REDIS_HOST || 'localhost',
          port: parseInt(process.env.REDIS_PORT || '6379'),
        },
        password: process.env.REDIS_PASSWORD || undefined,
      });
    }

    this.redisClient.on('error', (err) => {
      if (err.message.includes('NOAUTH') || err.message.includes('Authentication required')) {
        console.error('Redis Authentication Error: Check REDIS_PASSWORD in .env file');
      } else {
        console.error('Redis Client Error:', err);
      }
    });
  }

  setDatabaseService(db: DatabaseService): void {
    this.db = db;
  }

  // --------------- Redis lifecycle ---------------

  async connect(): Promise<void> {
    if (!this.redisClient.isOpen) {
      await this.redisClient.connect();
      if (!process.env.REDIS_URL && process.env.REDIS_PASSWORD) {
        try {
          await this.redisClient.sendCommand(['AUTH', process.env.REDIS_PASSWORD]);
        } catch (_error) {
          // Auth may be handled automatically
        }
      }
    }
  }

  async disconnect(): Promise<void> {
    if (this.redisClient.isOpen) {
      await this.redisClient.disconnect();
    }
  }

  // --------------- Generic Redis cache helpers (used by middleware) ---------------

  async getCachedValue(key: string): Promise<string | null> {
    await this.connect();
    return this.redisClient.get(key);
  }

  async setCachedValue(key: string, value: string, ttlSeconds: number): Promise<void> {
    await this.connect();
    await this.redisClient.setEx(key, ttlSeconds, value);
  }

  // --------------- PKCE ---------------

  private generatePKCE(): { codeVerifier: string; codeChallenge: string } {
    const codeVerifier = crypto.randomBytes(32).toString('base64url');
    const codeChallenge = crypto
      .createHash('sha256')
      .update(codeVerifier)
      .digest('base64url');
    return { codeVerifier, codeChallenge };
  }

  /**
   * Generate OAuth authorization URL.
   * PKCE is disabled by default. Enable with USE_PKCE=true.
   */
  async getAuthorizationUrl(state?: string): Promise<string> {
    const usePKCE = process.env.USE_PKCE === 'true';

    const oauth2 = new jsforce.OAuth2({
      clientId: this.clientId,
      clientSecret: this.clientSecret,
      redirectUri: this.redirectUri,
      loginUrl: this.loginUrl,
    });

    let baseUrl = oauth2.getAuthorizationUrl({
      scope: 'api id web refresh_token',
      state: state || '',
    });

    if (usePKCE) {
      await this.connect();
      const { codeVerifier, codeChallenge } = this.generatePKCE();
      const pkceKey = state ? `pkce:${state}` : `pkce:${Date.now()}`;
      await this.redisClient.setEx(pkceKey, 600, codeVerifier);

      const url = new URL(baseUrl);
      url.searchParams.set('code_challenge', codeChallenge);
      url.searchParams.set('code_challenge_method', 'S256');
      baseUrl = url.toString();
    }

    return baseUrl;
  }

  /**
   * Exchange authorization code for tokens.
   * Returns OrgSettings AND persists the tenant into PostgreSQL.
   * Caller receives the raw API key (only exposed once).
   */
  async authorize(
    code: string,
    billingMode: 'PERSONAL' | 'ENTERPRISE' = 'PERSONAL',
    gcpProjectId?: string,
    state?: string
  ): Promise<{ orgSettings: OrgSettings; apiKey: string }> {
    await this.connect();

    // Retrieve PKCE verifier
    let codeVerifier: string | null = null;
    if (state) {
      const pkceKey = `pkce:${state}`;
      codeVerifier = await this.redisClient.get(pkceKey);
      if (codeVerifier) await this.redisClient.del(pkceKey);
    }
    if (!codeVerifier) {
      const keys = await this.redisClient.keys('pkce:*');
      if (keys.length > 0) {
        const recentKey = keys.sort().reverse()[0];
        codeVerifier = await this.redisClient.get(recentKey);
        if (codeVerifier) await this.redisClient.del(recentKey);
      }
    }

    const oauth2 = new jsforce.OAuth2({
      clientId: this.clientId,
      clientSecret: this.clientSecret,
      redirectUri: this.redirectUri,
      loginUrl: this.loginUrl,
    });

    const conn = new jsforce.Connection({ oauth2, version: '58.0' });

    let userInfo;
    if (codeVerifier) {
      const tokenLoginUrl = this.loginUrl.includes('login.salesforce.com')
        ? this.loginUrl
        : 'https://login.salesforce.com';
      const tokenUrl = `${tokenLoginUrl}/services/oauth2/token`;

      let tokenParams = new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: this.clientId,
        redirect_uri: this.redirectUri,
        code,
        code_verifier: codeVerifier,
      });

      let response = await fetch(tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: tokenParams.toString(),
      });

      if (!response.ok && (response.status === 400 || response.status === 401)) {
        tokenParams = new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: this.clientId,
          client_secret: this.clientSecret,
          redirect_uri: this.redirectUri,
          code,
          code_verifier: codeVerifier,
        });
        response = await fetch(tokenUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: tokenParams.toString(),
        });
      }

      if (!response.ok) {
        const errorText = await response.text();
        if (state) await this.redisClient.del(`pkce:${state}`);
        throw new Error(
          `PKCE token exchange failed: ${response.status} ${errorText}. ` +
          'If PKCE is not required, set USE_PKCE=false in environment variables.'
        );
      }

      const tokenData = await response.json() as {
        access_token: string;
        refresh_token?: string;
        instance_url: string;
      };
      conn.accessToken = tokenData.access_token;
      conn.refreshToken = tokenData.refresh_token || '';
      conn.instanceUrl = tokenData.instance_url;
      userInfo = await conn.identity();
    } else {
      userInfo = await conn.authorize(code);
    }

    const orgId =
      (userInfo as any).organizationId ||
      (userInfo as any).id?.split('/')[0] ||
      '';

    const orgSettings: OrgSettings = {
      orgId,
      accessToken: conn.accessToken || '',
      refreshToken: conn.refreshToken || '',
      instanceUrl: conn.instanceUrl || '',
      billingMode,
      gcpProjectId,
    };

    // Generate API key and persist tenant in PostgreSQL
    const apiKey = DatabaseService.generateApiKey();
    const apiKeyHash = DatabaseService.hashApiKey(apiKey);
    const apiKeyPrefix = apiKey.substring(0, 12);

    if (this.db) {
      await this.db.upsertTenant({
        orgId: orgSettings.orgId,
        apiKeyHash,
        apiKeyPrefix,
        refreshToken: orgSettings.refreshToken,
        accessToken: orgSettings.accessToken,
        instanceUrl: orgSettings.instanceUrl,
        billingMode: orgSettings.billingMode,
        gcpProjectId: orgSettings.gcpProjectId,
      });
    }

    // Also cache in Redis for fast reads (backward compat + polling)
    await this.saveOrgSettings(orgSettings);

    return { orgSettings, apiKey };
  }

  // --------------- Org Settings (Redis cache layer) ---------------

  async saveOrgSettings(settings: OrgSettings): Promise<void> {
    await this.connect();
    const key = `org:${settings.orgId}`;
    await this.redisClient.setEx(key, 3600 * 24 * 7, JSON.stringify(settings));
  }

  /**
   * Retrieve OrgSettings for an orgId.
   * Checks Redis first, then falls back to PostgreSQL.
   */
  async getOrgSettings(orgId: string): Promise<OrgSettings | null> {
    await this.connect();
    const key = `org:${orgId}`;
    const cached = await this.redisClient.get(key);
    if (cached) return JSON.parse(cached);

    // Fallback to PostgreSQL
    if (this.db) {
      const tenant = await this.db.getTenantByOrgId(orgId);
      if (tenant) {
        const settings: OrgSettings = {
          orgId: tenant.org_id,
          accessToken: tenant.encrypted_access_token
            ? this.db.decryptAccessToken(tenant)
            : '',
          refreshToken: this.db.decryptRefreshToken(tenant),
          instanceUrl: tenant.instance_url,
          billingMode: tenant.billing_mode,
          gcpProjectId: tenant.gcp_project_id || undefined,
        };
        // Re-cache in Redis
        await this.saveOrgSettings(settings);
        return settings;
      }
    }

    return null;
  }

  // --------------- Deduplication (Redis only, ephemeral) ---------------

  private static readonly AUDIT_PROCESSED_TTL_SEC = 90000; // 25 hours

  async isAuditRecordProcessed(orgId: string, recordId: string): Promise<boolean> {
    if (!recordId || recordId.trim() === '') return false;
    await this.connect();
    const key = `audit_processed:${orgId}:${recordId}`;
    return (await this.redisClient.exists(key)) === 1;
  }

  async markAuditRecordProcessed(orgId: string, recordId: string): Promise<void> {
    if (!recordId || recordId.trim() === '') return;
    await this.connect();
    const key = `audit_processed:${orgId}:${recordId}`;
    await this.redisClient.setEx(key, SalesforceAuthService.AUDIT_PROCESSED_TTL_SEC, '1');
  }

  private static readonly VALIDATION_PROCESSED_TTL_SEC = 300;

  async isValidationRuleRecentlyProcessed(orgId: string, ruleName: string): Promise<boolean> {
    if (!ruleName || ruleName.trim() === '') return false;
    await this.connect();
    const key = `validation_processed:${orgId}:${ruleName}`;
    return (await this.redisClient.exists(key)) === 1;
  }

  async markValidationRuleProcessed(orgId: string, ruleName: string): Promise<void> {
    if (!ruleName || ruleName.trim() === '') return;
    await this.connect();
    const key = `validation_processed:${orgId}:${ruleName}`;
    await this.redisClient.setEx(key, SalesforceAuthService.VALIDATION_PROCESSED_TTL_SEC, '1');
  }

  private static readonly FLOW_THREAD_TTL_SEC = 129600; // 36 hours

  async getFlowThreadTs(orgId: string, flowDeveloperName: string): Promise<string | null> {
    await this.connect();
    const key = `flow_thread:${orgId}:${flowDeveloperName}`;
    return await this.redisClient.get(key);
  }

  async setFlowThreadTs(orgId: string, flowDeveloperName: string, threadTs: string): Promise<void> {
    await this.connect();
    const key = `flow_thread:${orgId}:${flowDeveloperName}`;
    await this.redisClient.setEx(key, SalesforceAuthService.FLOW_THREAD_TTL_SEC, threadTs);
  }

  async cleanupAuditProcessedKeys(): Promise<number> {
    await this.connect();
    const keys = await this.redisClient.keys('audit_processed:*');
    if (keys.length === 0) return 0;
    for (const key of keys) {
      await this.redisClient.del(key);
    }
    console.log(`[Auth] Cleaned up ${keys.length} audit_processed key(s)`);
    return keys.length;
  }

  // --------------- Org enumeration ---------------

  /**
   * Get all registered org IDs.
   * Prefers PostgreSQL (durable); falls back to Redis keys.
   */
  async getAllOrgIds(): Promise<string[]> {
    if (this.db) {
      const tenants = await this.db.getAllActiveTenants();
      return tenants.map((t) => t.org_id);
    }
    await this.connect();
    const keys = await this.redisClient.keys('org:*');
    return keys.map((key) => key.replace('org:', ''));
  }

  async removeOrg(orgId: string): Promise<void> {
    await this.connect();
    await this.redisClient.del(`org:${orgId}`);
    if (this.db) {
      await this.db.deactivateTenant(orgId);
    }
    console.log(`[Auth] Removed stale org ${orgId}`);
  }

  async getFirstValidOrgId(): Promise<string | null> {
    const orgIds = await this.getAllOrgIds();
    for (const orgId of orgIds) {
      try {
        await this.refreshSession(orgId);
        return orgId;
      } catch (err) {
        console.warn(`[Auth] Org ${orgId} refresh failed, removing stale entry:`, (err as Error).message);
        await this.removeOrg(orgId);
      }
    }
    return null;
  }

  // --------------- Token refresh ---------------

  async refreshSession(orgId: string): Promise<OrgSettings> {
    const settings = await this.getOrgSettings(orgId);
    if (!settings) throw new Error(`No settings found for orgId: ${orgId}`);
    if (!settings.refreshToken) throw new Error(`No refresh token for orgId: ${orgId}`);

    const refreshResponse = await fetch(`${this.loginUrl}/services/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: this.clientId,
        client_secret: this.clientSecret,
        refresh_token: settings.refreshToken,
      }).toString(),
    });

    if (!refreshResponse.ok) {
      throw new Error(`Token refresh failed: ${refreshResponse.status}`);
    }

    const refreshData = await refreshResponse.json() as {
      access_token: string;
      refresh_token?: string;
      instance_url: string;
    };

    const updatedSettings: OrgSettings = {
      ...settings,
      accessToken: refreshData.access_token,
      refreshToken: refreshData.refresh_token || settings.refreshToken,
      instanceUrl: refreshData.instance_url || settings.instanceUrl,
    };

    // Persist to both Redis cache AND PostgreSQL
    await this.saveOrgSettings(updatedSettings);
    if (this.db) {
      await this.db.updateTokens(
        orgId,
        updatedSettings.accessToken,
        refreshData.refresh_token || undefined
      );
    }

    return updatedSettings;
  }

  async getConnection(orgId: string): Promise<jsforce.Connection> {
    let settings = await this.getOrgSettings(orgId);
    if (!settings) throw new Error(`No settings found for orgId: ${orgId}`);

    try {
      settings = await this.refreshSession(orgId);
    } catch (error) {
      console.error(`Failed to refresh session for orgId ${orgId}:`, error);
    }

    const oauth2 = new jsforce.OAuth2({
      clientId: this.clientId,
      clientSecret: this.clientSecret,
      redirectUri: this.redirectUri,
      loginUrl: this.loginUrl,
    });

    return new jsforce.Connection({
      oauth2,
      accessToken: settings.accessToken,
      refreshToken: settings.refreshToken,
      instanceUrl: settings.instanceUrl,
      version: '58.0',
    });
  }
}
