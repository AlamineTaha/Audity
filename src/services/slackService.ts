/**
 * Slack Service
 * Sends formatted notifications to Slack using Block Kit
 * Handles safe channel invitations (avoids already_in_channel errors)
 */

import axios from 'axios';
import { AuditDiff, SlackNotification, ChangeNotification } from '../types';

const SLACK_API_BASE = 'https://slack.com/api';
const INVITE_BATCH_SIZE = 30; // Slack API limit per conversations.invite call

export class SlackService {
  private webhookUrl: string;
  private botToken: string;

  constructor() {
    this.webhookUrl = process.env.SLACK_WEBHOOK_URL || '';
    this.botToken = process.env.SLACK_BOT_TOKEN || '';
  }

  /**
   * Safe Invite: Check channel membership first, then invite only users not already present.
   * Ignores already_in_channel errors (race conditions). Logs/throws other errors.
   */
  async inviteUsersSafely(channelId: string, userIds: string[]): Promise<void> {
    if (!this.botToken) {
      console.warn('[SLACK] SLACK_BOT_TOKEN not configured, skipping invite');
      return;
    }
    if (!channelId || userIds.length === 0) {
      return;
    }

    const uniqueIds = [...new Set(userIds.map((id) => id.trim()).filter(Boolean))];
    if (uniqueIds.length === 0) return;

    console.log(`[SLACK] Checking membership for channel: ${channelId}`);

    try {
      const currentMembers = await this.getChannelMembers(channelId);
      const toInvite = uniqueIds.filter((id) => !currentMembers.includes(id));
      const alreadyPresent = uniqueIds.length - toInvite.length;

      console.log(`[SLACK] Users already present: ${alreadyPresent}. Users to invite: ${toInvite.length}.`);

      if (toInvite.length === 0) {
        console.log(`[SLACK] Invitation skipped for ${channelId} (all users already in channel).`);
        return;
      }

      for (let i = 0; i < toInvite.length; i += INVITE_BATCH_SIZE) {
        const batch = toInvite.slice(i, i + INVITE_BATCH_SIZE);
        await this.inviteBatch(channelId, batch);
      }

      console.log(`[SLACK] Invitation successful for ${channelId}.`);
    } catch (error) {
      if (this.isAlreadyInChannelError(error)) {
        console.log(`[SLACK] Invitation skipped for ${channelId} (already_in_channel race condition).`);
        return;
      }
      console.error(`[SLACK] Invitation failed for ${channelId}:`, error);
      throw error;
    }
  }

  private async getChannelMembers(channelId: string): Promise<string[]> {
    const members: string[] = [];
    let cursor: string | undefined;

    do {
      const params = new URLSearchParams({ channel: channelId, limit: '200' });
      if (cursor) params.set('cursor', cursor);

      const res = await axios.get(`${SLACK_API_BASE}/conversations.members?${params}`, {
        headers: { Authorization: `Bearer ${this.botToken}` },
      });

      if (!res.data?.ok) {
        throw new Error(res.data?.error || 'conversations.members failed');
      }

      members.push(...(res.data.members || []));
      cursor = res.data.response_metadata?.next_cursor;
    } while (cursor);

    return members;
  }

  private async inviteBatch(channelId: string, userIds: string[]): Promise<void> {
    const res = await axios.post(
      `${SLACK_API_BASE}/conversations.invite`,
      { channel: channelId, users: userIds.join(',') },
      { headers: { Authorization: `Bearer ${this.botToken}`, 'Content-Type': 'application/json' } }
    );

    if (!res.data?.ok) {
      const err = new Error(res.data?.error || 'conversations.invite failed') as Error & { code?: string };
      err.code = res.data?.error;
      throw err;
    }
  }

  private isAlreadyInChannelError(error: unknown): boolean {
    if (axios.isAxiosError(error) && error.response?.data?.error) {
      return error.response.data.error === 'already_in_channel';
    }
    const err = error as { code?: string };
    return err?.code === 'already_in_channel';
  }

  /**
   * Send change notification to Slack using Block Kit format
   * Format: Header, Fields (User, Risk Level, Time), Section (AI Summary), Action Button
   */
  async sendChangeNotification(notification: ChangeNotification): Promise<void> {
    if (!this.webhookUrl) {
      console.warn('SLACK_WEBHOOK_URL not configured, skipping notification');
      return;
    }

    const blocks = this.buildChangeNotificationBlocks(notification);

    try {
      await axios.post(this.webhookUrl, {
        text: `🚨 AuditDelta: ${notification.changeType} Detected`,
        blocks,
      });
    } catch (error) {
      if (axios.isAxiosError(error)) {
        console.error('Slack notification error:', error.response?.data || error.message);
      } else {
        console.error('Slack notification error:', error);
      }
    }
  }

  /**
   * Build Slack Block Kit blocks for change notification
   * Format: Header, Fields (User, Risk Level, Time), Section (AI Summary), Action Button
   */
  private buildChangeNotificationBlocks(notification: ChangeNotification): unknown[] {
    // Determine emoji based on risk level
    const riskEmoji = notification.riskLevel === 'High' ? '🔴' : 
                      notification.riskLevel === 'Medium' ? '🟡' : '🟢';

    return [
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: `🚨 AuditDelta: ${notification.changeType} Detected`,
          emoji: true,
        },
      },
      {
        type: 'section',
        fields: [
          {
            type: 'mrkdwn',
            text: `*User:*\n${notification.user}`,
          },
          {
            type: 'mrkdwn',
            text: `*Risk Level:*\n${riskEmoji} ${notification.riskLevel}`,
          },
          {
            type: 'mrkdwn',
            text: `*Time:*\n${new Date(notification.timestamp).toLocaleString()}`,
          },
        ],
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*AI Summary:*\n${this.truncateSummary(notification.summary)}`,
        },
      },
      ...(notification.changes.length > 0
        ? [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: `*Changes:*\n${notification.changes.map(c => `• ${c}`).join('\n')}`,
              },
            },
          ]
        : []),
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: {
              type: 'plain_text',
              text: 'View in Salesforce',
              emoji: true,
            },
            url: notification.salesforceUrl,
            style: 'primary',
          },
        ],
      },
    ];
  }

  /**
   * Send Flow change notification to Slack (legacy method for backward compatibility)
   */
  async sendFlowChangeNotification(diff: AuditDiff): Promise<void> {
    if (!this.webhookUrl) {
      console.warn('SLACK_WEBHOOK_URL not configured, skipping notification');
      return;
    }

    const blocks = this.buildFlowChangeBlocks(diff);

    try {
      await axios.post(this.webhookUrl, {
        text: `Flow Change Detected: ${diff.flowName}`,
        blocks,
      });
    } catch (error) {
      if (axios.isAxiosError(error)) {
        console.error('Slack notification error:', error.response?.data || error.message);
      } else {
        console.error('Slack notification error:', error);
      }
    }
  }

  /**
   * Truncate summary if it exceeds Slack's Block limit (3000 characters)
   * Adds a link to read the full report if truncated
   */
  private truncateSummary(summary: string, maxLength: number = 3000): string {
    if (summary.length <= maxLength) {
      return summary;
    }
    
    const truncated = summary.substring(0, maxLength - 100);
    const dashboardUrl = process.env.AUDITDELTA_DASHBOARD_URL || 'https://auditdelta.example.com';
    return `${truncated}...\n\n<${dashboardUrl}|Read full report in AuditDelta Dashboard.>`;
  }

  /**
   * Build Slack Block Kit blocks for Flow change notification (legacy)
   */
  private buildFlowChangeBlocks(diff: AuditDiff): unknown[] {
    return [
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: `🔄 Flow Change Detected: ${diff.flowName}`,
          emoji: true,
        },
      },
      {
        type: 'section',
        fields: [
          {
            type: 'mrkdwn',
            text: `*Flow:*\n${diff.flowApiName}`,
          },
          {
            type: 'mrkdwn',
            text: `*Versions:*\n${diff.oldVersion} → ${diff.newVersion}`,
          },
          {
            type: 'mrkdwn',
            text: `*Org ID:*\n${diff.orgId}`,
          },
          {
            type: 'mrkdwn',
            text: `*Time:*\n${new Date(diff.timestamp).toLocaleString()}`,
          },
        ],
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Summary:*\n${this.truncateSummary(diff.summary)}`,
        },
      },
      ...(diff.changes.length > 0
        ? [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: `*Changes:*\n${diff.changes.map(c => `• ${c}`).join('\n')}`,
              },
            },
          ]
        : []),
      {
        type: 'divider',
      },
    ];
  }

  /**
   * Send generic notification
   */
  async sendNotification(notification: SlackNotification): Promise<void> {
    if (!this.webhookUrl) {
      console.warn('SLACK_WEBHOOK_URL not configured, skipping notification');
      return;
    }

    try {
      await axios.post(this.webhookUrl, {
        text: notification.summary,
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `*${notification.flowName}*\n${notification.summary}`,
            },
          },
        ],
      });
    } catch (error) {
      console.error('Slack notification error:', error);
    }
  }
}

