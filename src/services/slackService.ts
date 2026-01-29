/**
 * Slack Service
 * Sends formatted notifications to Slack using Block Kit
 */

import axios from 'axios';
import { AuditDiff, SlackNotification, ChangeNotification } from '../types';

export class SlackService {
  private webhookUrl: string;

  constructor() {
    this.webhookUrl = process.env.SLACK_WEBHOOK_URL || '';
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

