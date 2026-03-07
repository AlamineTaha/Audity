/**
 * Database Service
 * PostgreSQL-backed persistent storage for multi-tenant org management.
 * Refresh tokens are encrypted at rest with AES-256-GCM.
 */

import { Pool } from 'pg';
import * as crypto from 'crypto';

export interface TenantRow {
  id: number;
  org_id: string;
  api_key_hash: string;
  api_key_prefix: string;
  encrypted_refresh_token: string;
  encrypted_access_token: string | null;
  instance_url: string;
  billing_mode: 'PERSONAL' | 'ENTERPRISE';
  gcp_project_id: string | null;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;

export class DatabaseService {
  private pool: Pool;
  private encryptionKey: Buffer;

  constructor() {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error('DATABASE_URL environment variable is required');
    }

    this.pool = new Pool({
      connectionString,
      ssl: process.env.NODE_ENV === 'production'
        ? { rejectUnauthorized: false }
        : undefined,
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });

    const keyHex = process.env.TENANT_ENCRYPTION_KEY;
    if (!keyHex || keyHex.length !== 64) {
      throw new Error(
        'TENANT_ENCRYPTION_KEY must be a 64-character hex string (32 bytes). ' +
        'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
      );
    }
    this.encryptionKey = Buffer.from(keyHex, 'hex');

    this.pool.on('error', (err) => {
      console.error('[Database] Unexpected pool error:', err.message);
    });
  }

  async initialize(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS tenants (
          id            SERIAL PRIMARY KEY,
          org_id        VARCHAR(18) UNIQUE NOT NULL,
          api_key_hash  VARCHAR(64) NOT NULL UNIQUE,
          api_key_prefix VARCHAR(12) NOT NULL,
          encrypted_refresh_token TEXT NOT NULL,
          encrypted_access_token  TEXT,
          instance_url  TEXT NOT NULL,
          billing_mode  VARCHAR(20) NOT NULL DEFAULT 'PERSONAL',
          gcp_project_id VARCHAR(255),
          is_active     BOOLEAN DEFAULT TRUE,
          created_at    TIMESTAMPTZ DEFAULT NOW(),
          updated_at    TIMESTAMPTZ DEFAULT NOW()
        )
      `);

      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_tenants_api_key_hash ON tenants(api_key_hash)
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_tenants_org_id ON tenants(org_id)
      `);

      console.log('[Database] Schema initialized');
    } finally {
      client.release();
    }
  }

  async disconnect(): Promise<void> {
    await this.pool.end();
  }

  // --------------- Encryption helpers ---------------

  encrypt(plaintext: string): string {
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, this.encryptionKey, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
  }

  decrypt(ciphertext: string): string {
    const [ivHex, authTagHex, encryptedHex] = ciphertext.split(':');
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');
    const encrypted = Buffer.from(encryptedHex, 'hex');
    const decipher = crypto.createDecipheriv(ALGORITHM, this.encryptionKey, iv);
    decipher.setAuthTag(authTag);
    return decipher.update(encrypted) + decipher.final('utf8');
  }

  // --------------- API Key helpers ---------------

  static generateApiKey(): string {
    return `adk_${crypto.randomBytes(32).toString('hex')}`;
  }

  static hashApiKey(apiKey: string): string {
    return crypto.createHash('sha256').update(apiKey).digest('hex');
  }

  // --------------- Tenant CRUD ---------------

  async upsertTenant(params: {
    orgId: string;
    apiKeyHash: string;
    apiKeyPrefix: string;
    refreshToken: string;
    accessToken: string;
    instanceUrl: string;
    billingMode: 'PERSONAL' | 'ENTERPRISE';
    gcpProjectId?: string;
  }): Promise<TenantRow> {
    const encryptedRefresh = this.encrypt(params.refreshToken);
    const encryptedAccess = this.encrypt(params.accessToken);

    const result = await this.pool.query<TenantRow>(
      `INSERT INTO tenants
         (org_id, api_key_hash, api_key_prefix, encrypted_refresh_token,
          encrypted_access_token, instance_url, billing_mode, gcp_project_id, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, TRUE)
       ON CONFLICT (org_id) DO UPDATE SET
         api_key_hash            = EXCLUDED.api_key_hash,
         api_key_prefix          = EXCLUDED.api_key_prefix,
         encrypted_refresh_token = EXCLUDED.encrypted_refresh_token,
         encrypted_access_token  = EXCLUDED.encrypted_access_token,
         instance_url            = EXCLUDED.instance_url,
         billing_mode            = EXCLUDED.billing_mode,
         gcp_project_id          = EXCLUDED.gcp_project_id,
         is_active               = TRUE,
         updated_at              = NOW()
       RETURNING *`,
      [
        params.orgId,
        params.apiKeyHash,
        params.apiKeyPrefix,
        encryptedRefresh,
        encryptedAccess,
        params.instanceUrl,
        params.billingMode,
        params.gcpProjectId || null,
      ]
    );

    return result.rows[0];
  }

  async getTenantByApiKeyHash(apiKeyHash: string): Promise<TenantRow | null> {
    const result = await this.pool.query<TenantRow>(
      'SELECT * FROM tenants WHERE api_key_hash = $1 AND is_active = TRUE',
      [apiKeyHash]
    );
    return result.rows[0] || null;
  }

  async getTenantByOrgId(orgId: string): Promise<TenantRow | null> {
    const result = await this.pool.query<TenantRow>(
      'SELECT * FROM tenants WHERE org_id = $1 AND is_active = TRUE',
      [orgId]
    );
    return result.rows[0] || null;
  }

  async getAllActiveTenants(): Promise<TenantRow[]> {
    const result = await this.pool.query<TenantRow>(
      'SELECT * FROM tenants WHERE is_active = TRUE ORDER BY created_at'
    );
    return result.rows;
  }

  async updateTokens(orgId: string, accessToken: string, refreshToken?: string): Promise<void> {
    const encryptedAccess = this.encrypt(accessToken);

    if (refreshToken) {
      const encryptedRefresh = this.encrypt(refreshToken);
      await this.pool.query(
        `UPDATE tenants
         SET encrypted_access_token = $1, encrypted_refresh_token = $2, updated_at = NOW()
         WHERE org_id = $3`,
        [encryptedAccess, encryptedRefresh, orgId]
      );
    } else {
      await this.pool.query(
        `UPDATE tenants SET encrypted_access_token = $1, updated_at = NOW() WHERE org_id = $2`,
        [encryptedAccess, orgId]
      );
    }
  }

  async deactivateTenant(orgId: string): Promise<void> {
    await this.pool.query(
      'UPDATE tenants SET is_active = FALSE, updated_at = NOW() WHERE org_id = $1',
      [orgId]
    );
  }

  /**
   * Decrypt the stored refresh token for a tenant row.
   */
  decryptRefreshToken(tenant: TenantRow): string {
    return this.decrypt(tenant.encrypted_refresh_token);
  }

  /**
   * Decrypt the stored access token for a tenant row.
   */
  decryptAccessToken(tenant: TenantRow): string {
    if (!tenant.encrypted_access_token) {
      throw new Error(`No access token stored for org ${tenant.org_id}`);
    }
    return this.decrypt(tenant.encrypted_access_token);
  }
}
