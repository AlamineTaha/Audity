/**
 * Aggregation Service
 * Implements intelligent notification debouncing using Redis
 * Aggregates changes for the same metadata item within a 5-minute window
 */

import { RedisClientType } from 'redis';
import { SetupAuditTrail } from '../types';

export interface AggregatedChange {
  orgId: string;
  metadataType: string;
  metadataName: string;
  userId: string;
  changes: Array<{
    auditRecord: SetupAuditTrail;
    timestamp: string;
    version?: number;
    summary?: string;
  }>;
  firstChangeTime: string;
  lastChangeTime: string;
}

export class AggregationService {
  private redisClient: RedisClientType;
  private ttlSeconds: number = 5 * 60; // 5 minutes
  private checkIntervalMs: number = 30 * 1000; // Check every 30 seconds
  private checkTimer: NodeJS.Timeout | null = null;
  private onAggregationReady: (change: AggregatedChange) => Promise<void>;

  constructor(
    redisClient: RedisClientType,
    onAggregationReady: (change: AggregatedChange) => Promise<void>
  ) {
    this.redisClient = redisClient;
    this.onAggregationReady = onAggregationReady;
  }

  /**
   * Start the background job to check for expired aggregations
   */
  start(): void {
    if (this.checkTimer) {
      return; // Already started
    }

    console.log('[AggregationService] Starting background aggregation checker');
    this.checkTimer = setInterval(() => {
      this.checkExpiredAggregations().catch(err => {
        console.error('[AggregationService] Error checking expired aggregations:', err);
      });
    }, this.checkIntervalMs);
  }

  /**
   * Stop the background job
   */
  stop(): void {
    if (this.checkTimer) {
      clearInterval(this.checkTimer);
      this.checkTimer = null;
      console.log('[AggregationService] Stopped background aggregation checker');
    }
  }

  /**
   * Generate a unique Redis key for an aggregation
   */
  private getAggregationKey(
    orgId: string,
    metadataType: string,
    metadataName: string,
    userId: string
  ): string {
    return `agg:${orgId}:${metadataType}:${metadataName}:${userId}`;
  }

  /**
   * Add a change to the aggregation buffer
   * Returns true if this is a new aggregation, false if it's an update to existing
   */
  async addChange(
    orgId: string,
    metadataType: string,
    metadataName: string,
    userId: string,
    auditRecord: SetupAuditTrail,
    version?: number,
    summary?: string
  ): Promise<boolean> {
    const key = this.getAggregationKey(orgId, metadataType, metadataName, userId);
    const timestamp = new Date().toISOString();

    try {
      // Get existing aggregation or create new
      const existing = await this.redisClient.get(key);
      let aggregated: AggregatedChange;

      if (existing) {
        aggregated = JSON.parse(existing);
        aggregated.changes.push({
          auditRecord,
          timestamp,
          version,
          summary,
        });
        aggregated.lastChangeTime = timestamp;
      } else {
        aggregated = {
          orgId,
          metadataType,
          metadataName,
          userId,
          changes: [{
            auditRecord,
            timestamp,
            version,
            summary,
          }],
          firstChangeTime: timestamp,
          lastChangeTime: timestamp,
        };
      }

      // Store with TTL (this resets the timer on each update)
      await this.redisClient.setEx(key, this.ttlSeconds, JSON.stringify(aggregated));

      const isNew = !existing;
      console.log(`[AggregationService] ${isNew ? 'Created' : 'Updated'} aggregation for ${metadataType}:${metadataName} (${aggregated.changes.length} change(s))`);
      
      return isNew;
    } catch (error) {
      console.error(`[AggregationService] Error adding change to aggregation:`, error);
      throw error;
    }
  }

  /**
   * Check for expired aggregations and process them
   */
  private async checkExpiredAggregations(): Promise<void> {
    try {
      // Get all aggregation keys
      const keys = await this.redisClient.keys('agg:*');

      for (const key of keys) {
        // Check TTL - if it's -1 or -2, the key has expired or doesn't exist
        const ttl = await this.redisClient.ttl(key);
        
        if (ttl === -1) {
          // Key exists but has no expiration (shouldn't happen, but handle it)
          console.warn(`[AggregationService] Key ${key} has no TTL, skipping`);
          continue;
        }

        if (ttl === -2) {
          // Key doesn't exist (already processed or expired)
          continue;
        }

        // If TTL is 0 or negative, the key has expired
        if (ttl <= 0) {
          await this.processExpiredAggregation(key);
        }
      }
    } catch (error) {
      console.error('[AggregationService] Error checking expired aggregations:', error);
    }
  }

  /**
   * Process an expired aggregation
   */
  private async processExpiredAggregation(key: string): Promise<void> {
    try {
      const data = await this.redisClient.get(key);
      
      if (!data) {
        // Already processed or doesn't exist
        return;
      }

      const aggregated: AggregatedChange = JSON.parse(data);

      // Delete the key before processing to prevent double-processing
      await this.redisClient.del(key);

      console.log(`[AggregationService] Processing expired aggregation: ${aggregated.metadataType}:${aggregated.metadataName} (${aggregated.changes.length} change(s))`);

      // Call the callback to process the aggregated changes
      await this.onAggregationReady(aggregated);
    } catch (error) {
      console.error(`[AggregationService] Error processing expired aggregation ${key}:`, error);
    }
  }

  /**
   * Force immediate processing of an aggregation (bypass TTL)
   * Used for on-demand triggers
   */
  async forceProcess(
    orgId: string,
    metadataType: string,
    metadataName: string,
    userId: string
  ): Promise<AggregatedChange | null> {
    const key = this.getAggregationKey(orgId, metadataType, metadataName, userId);
    
    try {
      const data = await this.redisClient.get(key);
      
      if (!data) {
        return null;
      }

      const aggregated: AggregatedChange = JSON.parse(data);
      
      // Delete the key
      await this.redisClient.del(key);

      console.log(`[AggregationService] Force processing aggregation: ${aggregated.metadataType}:${aggregated.metadataName}`);

      return aggregated;
    } catch (error) {
      console.error(`[AggregationService] Error force processing aggregation:`, error);
      throw error;
    }
  }

  /**
   * Get category for metadata type (for channel routing)
   */
  getCategory(metadataType: string): 'Security' | 'Automation' | 'Schema' {
    switch (metadataType) {
      case 'FlowDefinition':
        return 'Automation';
      case 'ValidationRule':
      case 'CustomField':
        return 'Schema';
      case 'PermissionSet':
        return 'Security';
      default:
        return 'Schema'; // Default to Schema
    }
  }
}
