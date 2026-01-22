/**
 * Slack Service
 * Sends formatted notifications to Slack using Block Kit
 */

import axios from 'axios';
import { AuditDiff, SlackNotification } from '../types';

export class SlackService {
  private webhookUrl: string;

  constructor() {
    this.webhookUrl = process.env.SLACK_WEBHOOK_URL || '';
  }

  /**
   * Send Flow change notification to Slack
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
   * Build Slack Block Kit blocks for Flow change notification
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
          text: `*Summary:*\n${diff.summary}`,
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

