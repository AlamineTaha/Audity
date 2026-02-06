/**
 * Salesforce Authentication Service
 * Handles OAuth 2.0 Web Server Flow and token management via Redis
 */

import * as jsforce from 'jsforce';
import { createClient, RedisClientType } from 'redis';
import * as crypto from 'crypto';
import { OrgSettings } from '../types';

export class SalesforceAuthService {
  private redisClient: RedisClientType;
  private clientId: string;
  private clientSecret: string;
  private redirectUri: string;
  private loginUrl: string;

  constructor() {
    this.clientId = process.env.SF_CLIENT_ID || '';
    this.clientSecret = process.env.SF_CLIENT_SECRET || '';
    this.redirectUri = process.env.SF_REDIRECT_URI || '';
    this.loginUrl = process.env.SF_LOGIN_URL || 'https://login.salesforce.com';

    // Initialize Redis client
    this.redisClient = createClient({
      socket: {
        host: process.env.REDIS_HOST || 'localhost',
        port: parseInt(process.env.REDIS_PORT || '6379'),
      },
      password: process.env.REDIS_PASSWORD || undefined,
    });

    this.redisClient.on('error', (err) => {
      if (err.message.includes('NOAUTH') || err.message.includes('Authentication required')) {
        console.error('Redis Authentication Error: Check REDIS_PASSWORD in .env file');
        console.error('If Redis requires authentication, set REDIS_PASSWORD in your .env file');
      } else {
        console.error('Redis Client Error:', err);
      }
    });
  }

  /**
   * Connect to Redis
   */
  async connect(): Promise<void> {
    if (!this.redisClient.isOpen) {
      await this.redisClient.connect();
      
      // Authenticate if password is set
      // Note: Redis v4+ client should handle auth automatically via password option,
      // but we'll ensure it's authenticated explicitly for compatibility
      if (process.env.REDIS_PASSWORD) {
        try {
          await this.redisClient.sendCommand(['AUTH', process.env.REDIS_PASSWORD]);
        } catch (error) {
          // If AUTH fails, it might be because auth was already done or not required
          // Log but don't fail - the connection might still work
          console.warn('Redis AUTH command failed (this may be normal if auth is handled automatically):', error);
        }
      }
    }
  }

  /**
   * Disconnect from Redis
   */
  async disconnect(): Promise<void> {
    if (this.redisClient.isOpen) {
      await this.redisClient.disconnect();
    }
  }

  /**
   * Generate PKCE code verifier and challenge
   */
  private generatePKCE(): { codeVerifier: string; codeChallenge: string } {
    // Generate code_verifier (43-128 characters, URL-safe)
    const codeVerifier = crypto.randomBytes(32).toString('base64url');
    
    // Generate code_challenge (SHA256 hash, base64url encoded)
    const codeChallenge = crypto
      .createHash('sha256')
      .update(codeVerifier)
      .digest('base64url');
    
    return { codeVerifier, codeChallenge };
  }

  /**
   * Generate OAuth authorization URL
   * PKCE is disabled by default. Enable by setting USE_PKCE=true in environment variables.
   */
  async getAuthorizationUrl(state?: string): Promise<string> {
    const usePKCE = process.env.USE_PKCE === 'true';

    const oauth2 = new jsforce.OAuth2({
      clientId: this.clientId,
      clientSecret: this.clientSecret,
      redirectUri: this.redirectUri,
      loginUrl: this.loginUrl,
    });

    // Get base authorization URL
    let baseUrl = oauth2.getAuthorizationUrl({
      scope: 'api id web refresh_token',
      state: state || '',
    });

    // Only add PKCE if explicitly enabled
    if (usePKCE) {
      await this.connect();
      
      // Generate PKCE parameters
      const { codeVerifier, codeChallenge } = this.generatePKCE();
      
      // Store code_verifier in Redis with short TTL (10 minutes)
      const pkceKey = state ? `pkce:${state}` : `pkce:${Date.now()}`;
      await this.redisClient.setEx(pkceKey, 600, codeVerifier);

      // Append PKCE parameters
      const url = new URL(baseUrl);
      url.searchParams.set('code_challenge', codeChallenge);
      url.searchParams.set('code_challenge_method', 'S256');
      baseUrl = url.toString();
    }

    return baseUrl;
  }

  /**
   * Exchange authorization code for access token with PKCE
   */
  async authorize(
    code: string, 
    billingMode: 'PERSONAL' | 'ENTERPRISE' = 'PERSONAL', 
    gcpProjectId?: string,
    state?: string
  ): Promise<OrgSettings> {
    await this.connect();

    // Retrieve code_verifier from Redis
    let codeVerifier: string | null = null;
    
    if (state) {
      const pkceKey = `pkce:${state}`;
      codeVerifier = await this.redisClient.get(pkceKey);
      
      // Clean up after retrieval
      if (codeVerifier) {
        await this.redisClient.del(pkceKey);
      }
    }
    
    // If not found by state, try to find any recent PKCE (fallback)
    if (!codeVerifier) {
      const keys = await this.redisClient.keys('pkce:*');
      if (keys.length > 0) {
        // Get the most recent one (sort by timestamp if using timestamp keys)
        const recentKey = keys.sort().reverse()[0];
        codeVerifier = await this.redisClient.get(recentKey);
        // Clean up
        if (codeVerifier) {
          await this.redisClient.del(recentKey);
        }
      }
    }

    const oauth2 = new jsforce.OAuth2({
      clientId: this.clientId,
      clientSecret: this.clientSecret,
      redirectUri: this.redirectUri,
      loginUrl: this.loginUrl,
    });

    const conn = new jsforce.Connection({ 
      oauth2,
      version: '58.0' // Use API version 58.0 (latest stable, well above v44.0 requirement)
    });
    
    // Authorize with code_verifier if available (PKCE flow)
    let userInfo;
    if (codeVerifier) {
      // Use manual token exchange with PKCE
      // Use standard login URL for token endpoint (not custom domain)
      const tokenLoginUrl = this.loginUrl.includes('login.salesforce.com') 
        ? this.loginUrl 
        : 'https://login.salesforce.com';
      const tokenUrl = `${tokenLoginUrl}/services/oauth2/token`;
      
      // Try without client_secret first (for Public clients with PKCE)
      let tokenParams = new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: this.clientId,
        redirect_uri: this.redirectUri,
        code: code,
        code_verifier: codeVerifier,
      });

      let response = await fetch(tokenUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: tokenParams.toString(),
      });

      // If that fails, try with client_secret (for Confidential clients)
      if (!response.ok && (response.status === 400 || response.status === 401)) {
        console.log('[PKCE] Retrying token exchange with client_secret...');
        tokenParams = new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: this.clientId,
          client_secret: this.clientSecret,
          redirect_uri: this.redirectUri,
          code: code,
          code_verifier: codeVerifier,
        });

        response = await fetch(tokenUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: tokenParams.toString(),
        });
      }

      // If PKCE fails, we can't fall back because the code was issued with PKCE
      if (!response.ok) {
        const errorText = await response.text();
        const errorDetails = `Token exchange failed: ${response.status} ${errorText}`;
        console.error(`[PKCE] ${errorDetails}`);
        
        // Clean up PKCE verifier
        if (state) {
          await this.redisClient.del(`pkce:${state}`);
        }
        
        throw new Error(`PKCE token exchange failed: ${errorDetails}. If PKCE is not required, set USE_PKCE=false in environment variables.`);
      } else {
        // PKCE succeeded
        const tokenData = await response.json() as {
          access_token: string;
          refresh_token?: string;
          instance_url: string;
        };
        conn.accessToken = tokenData.access_token;
        conn.refreshToken = tokenData.refresh_token || '';
        conn.instanceUrl = tokenData.instance_url;
        
        // Get user info using jsforce identity method
        userInfo = await conn.identity();
      }
    } else {
      // No PKCE verifier, use standard OAuth flow
      console.log('[OAuth] No PKCE verifier found, using standard OAuth flow');
      userInfo = await conn.authorize(code);
    }

    const orgSettings: OrgSettings = {
      orgId: (userInfo as any).organizationId || (userInfo as any).id?.split('/')[0] || '',
      accessToken: conn.accessToken || '',
      refreshToken: conn.refreshToken || '',
      instanceUrl: conn.instanceUrl || '',
      billingMode,
      gcpProjectId,
    };

    // Store in Redis
    await this.saveOrgSettings(orgSettings);

    return orgSettings;
  }

  /**
   * Save organization settings to Redis
   */
  async saveOrgSettings(settings: OrgSettings): Promise<void> {
    await this.connect();
    const key = `org:${settings.orgId}`;
    await this.redisClient.setEx(key, 3600 * 24 * 7, JSON.stringify(settings)); // 7 days TTL
  }

  /**
   * Get organization settings from Redis
   */
  async getOrgSettings(orgId: string): Promise<OrgSettings | null> {
    await this.connect();
    const key = `org:${orgId}`;
    const data = await this.redisClient.get(key);
    return data ? JSON.parse(data) : null;
  }

  /**
   * Get all registered organization IDs from Redis
   */
  async getAllOrgIds(): Promise<string[]> {
    await this.connect();
    const keys = await this.redisClient.keys('org:*');
    // Extract org IDs from keys (format: "org:00D000000000000AAA")
    return keys.map(key => key.replace('org:', ''));
  }


  /**
   * Refresh access token for an organization
   * This is crucial for maintaining active sessions
   */
  async refreshSession(orgId: string): Promise<OrgSettings> {
    const settings = await this.getOrgSettings(orgId);
    if (!settings) {
      throw new Error(`No settings found for orgId: ${orgId}`);
    }

    if (!settings.refreshToken) {
      throw new Error(`No refresh token available for orgId: ${orgId}`);
    }

    const oauth2 = new jsforce.OAuth2({
      clientId: this.clientId,
      clientSecret: this.clientSecret,
      redirectUri: this.redirectUri,
      loginUrl: this.loginUrl,
    });

    const conn = new jsforce.Connection({ 
      oauth2,
      version: '58.0' // Use API version 58.0 (latest stable, well above v44.0 requirement)
    });
    conn.accessToken = settings.accessToken;
    conn.refreshToken = settings.refreshToken;
    conn.instanceUrl = settings.instanceUrl;

    // Refresh the token using OAuth2 refresh token flow
    const refreshResponse = await fetch(`${this.loginUrl}/services/oauth2/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
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

    conn.accessToken = refreshData.access_token;
    conn.refreshToken = refreshData.refresh_token || settings.refreshToken;
    conn.instanceUrl = refreshData.instance_url || settings.instanceUrl;

    // Update settings with new token
    const updatedSettings: OrgSettings = {
      ...settings,
      accessToken: conn.accessToken,
      refreshToken: conn.refreshToken || settings.refreshToken,
      instanceUrl: conn.instanceUrl,
    };

    // Save updated settings
    await this.saveOrgSettings(updatedSettings);

    return updatedSettings;
  }

  /**
   * Get a valid connection for an organization (refreshes if needed)
   */
  async getConnection(orgId: string): Promise<jsforce.Connection> {
    let settings = await this.getOrgSettings(orgId);
    if (!settings) {
      throw new Error(`No settings found for orgId: ${orgId}`);
    }

    // Try to refresh the session to ensure token is valid
    try {
      settings = await this.refreshSession(orgId);
    } catch (error) {
      console.error(`Failed to refresh session for orgId ${orgId}:`, error);
      // Continue with existing token, connection will fail if invalid
    }

    const oauth2 = new jsforce.OAuth2({
      clientId: this.clientId,
      clientSecret: this.clientSecret,
      redirectUri: this.redirectUri,
      loginUrl: this.loginUrl,
    });

    const conn = new jsforce.Connection({
      oauth2,
      accessToken: settings.accessToken,
      refreshToken: settings.refreshToken,
      instanceUrl: settings.instanceUrl,
      version: '58.0' // Use API version 58.0 (latest stable, well above v44.0 requirement)
    });

    return conn;
  }
}

