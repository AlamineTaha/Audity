/**
 * Waiting Room Service
 * Redis-based debouncing system that aggregates rapid changes
 * Uses active_session key with 300s TTL + Redis Keyspace Notifications (Ex) for expiration
 */

import { RedisClientType } from 'redis';
import { SetupAuditTrail } from '../types';

export interface BufferedChange {
  auditRecord: SetupAuditTrail;
  timestamp: string;
  version?: number;
  summary?: string;
  metadataType: string;
  metadataName: string;
}

export interface WaitingRoomSession {
  orgId: string;
  metadataName: string;
  userId: string;
  metadataType: string;
  changes: BufferedChange[];
  firstChangeTime: string;
  lastChangeTime: string;
  threadTimestamp?: string;
}

/** Session TTL: 300 seconds (5 min) - when no activity, session expires */
const SESSION_TTL_SEC = 300;

export class WaitingRoomService {
  private redisClient: RedisClientType;
  private onSessionReady: (session: WaitingRoomSession) => Promise<void>;
  private keyspaceSubscriber: RedisClientType | null = null;

  constructor(
    redisClient: RedisClientType,
    onSessionReady: (session: WaitingRoomSession) => Promise<void>
  ) {
    this.redisClient = redisClient;
    this.onSessionReady = onSessionReady;
  }

  /**
   * Redis key for the buffer list: buffer:[orgId]:[flowName]
   */
  private getBufferKey(orgId: string, flowName: string): string {
    return `buffer:${orgId}:${flowName}`;
  }

  /**
   * Redis key for active session (TTL 300s): active_session:[orgId]:[flowName]
   * When this expires, onSessionExpired fires
   */
  private getActiveSessionKey(orgId: string, flowName: string): string {
    return `active_session:${orgId}:${flowName}`;
  }

  /**
   * Redis key for thread timestamp storage
   */
  private getThreadKey(orgId: string, metadataName: string, userId: string): string {
    return `audit_thread:${orgId}:${metadataName}:${userId}`;
  }

  /**
   * Enable Redis Keyspace Notifications for 'Ex' (Expired) events
   */
  private async enableRedisExpiredNotifications(): Promise<void> {
    try {
      if (!this.redisClient.isOpen) return;
      await this.redisClient.sendCommand(['CONFIG', 'SET', 'notify-keyspace-events', 'Ex']);
      console.log('[WaitingRoom] Redis notify-keyspace-events set to Ex (expired)');
    } catch (err) {
      console.warn('[WaitingRoom] Could not set Redis notify-keyspace-events (may need redis.conf):', err);
    }
  }

  /**
   * Start the waiting room service
   * Enables Redis Ex notifications and subscribes to active_session:* expiration
   */
  async start(): Promise<void> {
    if (this.keyspaceSubscriber) {
      return; // Already started
    }

    await this.enableRedisExpiredNotifications();

    try {
      const { createClient } = await import('redis');
      this.keyspaceSubscriber = createClient({
        socket: {
          host: process.env.REDIS_HOST || 'localhost',
          port: parseInt(process.env.REDIS_PORT || '6379'),
        },
        password: process.env.REDIS_PASSWORD || undefined,
      });

      await this.keyspaceSubscriber.connect();

      await this.keyspaceSubscriber.pSubscribe('__keyspace@0__:active_session:*', (message, channel) => {
        if (message === 'expired') {
          const key = channel.replace('__keyspace@0__:', '');
          this.onSessionExpired(key).catch(err => {
            console.error(`[WaitingRoom] Error in onSessionExpired ${key}:`, err);
          });
        }
      });

      console.log('[WaitingRoom] Listener active for active_session:* expiration (300s TTL)');
    } catch (error) {
      console.error('[WaitingRoom] Failed to start keyspace listener:', error);
      throw error;
    }
  }

  /**
   * onSessionExpired: When active_session:[orgId]:[flowName] expires
   * Fetch all records from buffer:[orgId]:[flowName], pass to AI, publish ONE Slack message, clear list
   */
  private async onSessionExpired(activeSessionKey: string): Promise<void> {
    try {
      // active_session:orgId:flowName
      const parts = activeSessionKey.split(':');
      if (parts.length !== 3) {
        console.error(`[WaitingRoom] Invalid active_session key: ${activeSessionKey}`);
        return;
      }

      const [, orgId, flowName] = parts;
      const bufferKey = this.getBufferKey(orgId, flowName);

      const changeStrings = await this.redisClient.lRange(bufferKey, 0, -1);
      if (changeStrings.length === 0) {
        return;
      }

      const changes: BufferedChange[] = changeStrings.map(str => JSON.parse(str));
      changes.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

      const session: WaitingRoomSession = {
        orgId,
        metadataName: flowName,
        userId: changes[0].auditRecord.CreatedBy?.Id || 'unknown',
        metadataType: changes[0].metadataType,
        changes,
        firstChangeTime: changes[0].timestamp,
        lastChangeTime: changes[changes.length - 1].timestamp,
      };

      const threadKey = this.getThreadKey(orgId, flowName, session.userId);
      session.threadTimestamp = (await this.redisClient.get(threadKey)) || undefined;

      console.log(`[WaitingRoom] Session expired for ${bufferKey}, processing ${changes.length} change(s)`);
      await this.onSessionReady(session);

      await this.redisClient.del(bufferKey);
      console.log(`[WaitingRoom] Cleared buffer ${bufferKey}`);
    } catch (error) {
      console.error(`[WaitingRoom] onSessionExpired failed for ${activeSessionKey}:`, error);
    }
  }

  /**
   * Add a change to the waiting room buffer
   * Sets/resets 300s TTL on active_session:[orgId]:[flowName]
   */
  async addToWaitingRoom(
    orgId: string,
    metadataName: string,
    userId: string,
    metadataType: string,
    auditRecord: SetupAuditTrail,
    version?: number,
    summary?: string
  ): Promise<void> {
    const bufferKey = this.getBufferKey(orgId, metadataName);
    const activeSessionKey = this.getActiveSessionKey(orgId, metadataName);

    const change: BufferedChange = {
      auditRecord,
      timestamp: new Date().toISOString(),
      version,
      summary,
      metadataType,
      metadataName,
    };

    try {
      await this.redisClient.lPush(bufferKey, JSON.stringify(change));
      await this.redisClient.setEx(activeSessionKey, SESSION_TTL_SEC, '1');
      console.log(`[WaitingRoom] Added to buffer ${bufferKey}, active_session TTL 300s`);
    } catch (error) {
      console.error('[WaitingRoom] Error adding to waiting room:', error);
      throw error;
    }
  }

  /**
   * Store thread timestamp for future sessions
   */
  async storeThreadTimestamp(
    orgId: string,
    metadataName: string,
    userId: string,
    threadTimestamp: string
  ): Promise<void> {
    const threadKey = this.getThreadKey(orgId, metadataName, userId);
    try {
      await this.redisClient.setEx(threadKey, 7 * 24 * 60 * 60, threadTimestamp);
    } catch (error) {
      console.error('[WaitingRoom] Error storing thread timestamp:', error);
    }
  }

  /**
   * Force process a buffer immediately
   */
  async forceProcess(
    orgId: string,
    metadataName: string,
    _userId: string
  ): Promise<WaitingRoomSession | null> {
    const bufferKey = this.getBufferKey(orgId, metadataName);
    const exists = await this.redisClient.exists(bufferKey);
    if (!exists) return null;

    const changeStrings = await this.redisClient.lRange(bufferKey, 0, -1);
    const changes: BufferedChange[] = changeStrings.map(str => JSON.parse(str));
    changes.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

    const session: WaitingRoomSession = {
      orgId,
      metadataName,
      userId: changes[0].auditRecord.CreatedBy?.Id || 'unknown',
      metadataType: changes[0].metadataType,
      changes,
      firstChangeTime: changes[0].timestamp,
      lastChangeTime: changes[changes.length - 1].timestamp,
    };

    await this.onSessionReady(session);
    await this.redisClient.del(bufferKey);
    return null;
  }

  /**
   * Stop the waiting room service
   */
  stop(): void {
    if (this.keyspaceSubscriber) {
      this.keyspaceSubscriber.quit().catch(err => {
        console.error('[WaitingRoom] Error closing keyspace subscriber:', err);
      });
      this.keyspaceSubscriber = null;
    }
    console.log('[WaitingRoom] Stopped');
  }
}
