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

export const SF_API_VERSION = process.env.SF_API_VERSION || '68.0';
const OAUTH_STATE_TTL_SEC = 600;

export interface SlackLinkIntent {
  teamId: string;
  userId: string;
  channelId?: string;
}

interface PendingAuthorization {
  codeVerifier: string;
  loginUrl: string;
  billingMode: 'PERSONAL' | 'ENTERPRISE';
  gcpProjectId?: string;
  slackLink?: SlackLinkIntent;
}

export class OAuthStateError extends Error {}

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

  async deleteCachedValue(key: string): Promise<void> {
    await this.connect();
    await this.redisClient.del(key);
  }

  // --------------- OAuth (Web Server flow + PKCE) ---------------

  /** Salesforce login host for the OAuth dance: production, sandbox, or a My Domain URL. */
  static resolveLoginUrl(input: string | undefined, fallback: string): string {
    if (!input) return fallback;
    if (input === 'sandbox') return 'https://test.salesforce.com';
    if (input === 'production') return 'https://login.salesforce.com';
    const url = new URL(input);
    if (url.protocol !== 'https:' || !/(^|\.)salesforce\.com$/.test(url.hostname)) {
      throw new Error('loginUrl must be an https://*.salesforce.com URL, "sandbox" or "production"');
    }
    return url.origin;
  }

  async startAuthorization(options: {
    loginUrl?: string;
    billingMode?: 'PERSONAL' | 'ENTERPRISE';
    gcpProjectId?: string;
    slackLink?: SlackLinkIntent;
  }): Promise<string> {
    await this.connect();
    const loginUrl = SalesforceAuthService.resolveLoginUrl(options.loginUrl, this.loginUrl);
    const state = crypto.randomBytes(24).toString('base64url');
    const codeVerifier = crypto.randomBytes(32).toString('base64url');
    const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');

    const pending: PendingAuthorization = {
      codeVerifier,
      loginUrl,
      billingMode: options.billingMode ?? 'PERSONAL',
      gcpProjectId: options.gcpProjectId,
      slackLink: options.slackLink,
    };
    await this.redisClient.setEx(`oauth_state:${state}`, OAUTH_STATE_TTL_SEC, JSON.stringify(pending));

    const url = new URL(`${loginUrl}/services/oauth2/authorize`);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', this.clientId);
    url.searchParams.set('redirect_uri', this.redirectUri);
    url.searchParams.set('scope', 'api refresh_token');
    url.searchParams.set('state', state);
    url.searchParams.set('code_challenge', codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');
    return url.toString();
  }

  /**
   * Exchange the authorization code for tokens and persist the tenant.
   * The raw API key is returned once; it is only stored hashed.
   */
  async completeAuthorization(code: string, state: string): Promise<{
    orgSettings: OrgSettings;
    apiKey: string;
    slackLink?: SlackLinkIntent;
  }> {
    await this.connect();
    const stateKey = `oauth_state:${state}`;
    const raw = await this.redisClient.get(stateKey);
    if (!raw) {
      throw new OAuthStateError('This sign-in link has expired or was already used. Please start again.');
    }
    await this.redisClient.del(stateKey);
    const pending = JSON.parse(raw) as PendingAuthorization;

    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
      code,
      code_verifier: pending.codeVerifier,
    });
    if (this.clientSecret) body.set('client_secret', this.clientSecret);

    const response = await fetch(`${pending.loginUrl}/services/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    if (!response.ok) {
      throw new Error(`Salesforce token exchange failed: ${response.status} ${await response.text()}`);
    }
    const tokenData = await response.json() as { access_token: string; refresh_token?: string; instance_url: string; id: string };
    if (!tokenData.refresh_token) {
      throw new Error('Salesforce did not return a refresh token. Ensure the app has the refresh_token scope.');
    }

    // Identity URL format: https://login.salesforce.com/id/{orgId}/{userId}
    const orgId = new URL(tokenData.id).pathname.split('/')[2];
    const orgSettings: OrgSettings = {
      orgId,
      accessToken: tokenData.access_token,
      refreshToken: tokenData.refresh_token,
      instanceUrl: tokenData.instance_url,
      billingMode: pending.billingMode,
      gcpProjectId: pending.gcpProjectId,
    };

    const apiKey = DatabaseService.generateApiKey();
    if (this.db) {
      await this.db.upsertTenant({
        orgId,
        apiKeyHash: DatabaseService.hashApiKey(apiKey),
        apiKeyPrefix: apiKey.substring(0, 12),
        refreshToken: orgSettings.refreshToken,
        accessToken: orgSettings.accessToken,
        instanceUrl: orgSettings.instanceUrl,
        billingMode: orgSettings.billingMode,
        gcpProjectId: orgSettings.gcpProjectId,
      });
    }
    await this.saveOrgSettings(orgSettings);

    return { orgSettings, apiKey, slackLink: pending.slackLink };
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

  async cleanupAuditProcessedKeys(orgId: string): Promise<number> {
    await this.connect();
    let count = 0;
    for await (const key of this.redisClient.scanIterator({ MATCH: `audit_processed:${orgId}:*`, COUNT: 500 })) {
      await this.redisClient.del(key);
      count++;
    }
    console.log(`[Auth] Cleaned up ${count} audit_processed key(s) for ${orgId}`);
    return count;
  }

  // --------------- Audit trail high-water mark (no TTL: survives restarts) ---------------

  async getAuditHighWaterMark(orgId: string): Promise<Date | null> {
    await this.connect();
    const value = await this.redisClient.get(`audit_hwm:${orgId}`);
    return value ? new Date(value) : null;
  }

  async setAuditHighWaterMark(orgId: string, createdDate: string): Promise<void> {
    await this.connect();
    await this.redisClient.set(`audit_hwm:${orgId}`, new Date(createdDate).toISOString());
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

    // The org's own instance accepts token requests, which also covers sandboxes and My Domains.
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: this.clientId,
      refresh_token: settings.refreshToken,
    });
    if (this.clientSecret) body.set('client_secret', this.clientSecret);
    const refreshResponse = await fetch(`${settings.instanceUrl}/services/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
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

    await this.saveOrgSettings(updatedSettings);
    if (this.db) {
      await this.db.updateTokens(orgId, updatedSettings.accessToken, refreshData.refresh_token || undefined);
    }

    return updatedSettings;
  }

  /** jsforce refreshes on INVALID_SESSION_ID itself; the 'refresh' hook persists the new token. */
  async getConnection(orgId: string): Promise<jsforce.Connection> {
    const settings = await this.getOrgSettings(orgId);
    if (!settings) throw new Error(`No settings found for orgId: ${orgId}`);
    const conn = new jsforce.Connection({
      oauth2: new jsforce.OAuth2({
        clientId: this.clientId,
        clientSecret: this.clientSecret || undefined,
        redirectUri: this.redirectUri,
        loginUrl: settings.instanceUrl,
      }),
      accessToken: settings.accessToken,
      refreshToken: settings.refreshToken,
      instanceUrl: settings.instanceUrl,
      version: SF_API_VERSION,
    });
    conn.on('refresh', (accessToken: string) => {
      const updated = { ...settings, accessToken };
      this.saveOrgSettings(updated)
        .then(() => this.db?.updateTokens(orgId, accessToken))
        .catch((err) => console.error(`[Auth] Failed to persist refreshed token for ${orgId}:`, err));
    });
    return conn;
  }
}
