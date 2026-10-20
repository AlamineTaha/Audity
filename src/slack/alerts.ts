import { authService } from '../services/container';
import { ensureInChannel, slackClientForTeam } from './app';
import { alertBlocks } from './blocks';
import { slackDb } from './store';

const THREAD_TTL_SEC = 36 * 60 * 60;
const slackErrorCode = (error: unknown) => (error as { data?: { error?: string } }).data?.error;

/**
 * Posts a change alert to every Slack channel subscribed to the org. Repeated changes to
 * the same component within 36h are threaded under the first alert.
 * Returns false when no Slack channel is subscribed (caller falls back to Salesforce).
 */
export async function publishChangeToSlack(orgId: string, text: string, component: string, category: string): Promise<boolean> {
  const links = (await slackDb().getSlackLinksForOrg(orgId)).filter((l) => l.alert_channel_id);
  let delivered = false;

  for (const link of links) {
    const client = await slackClientForTeam(link.team_id);
    const channel = link.alert_channel_id;
    if (!client || !channel) continue;

    const threadKey = `slack_alert_thread:${link.team_id}:${orgId}:${component}`;
    const threadTs = await authService.getCachedValue(threadKey);
    const message = {
      channel,
      thread_ts: threadTs ?? undefined,
      text: text.slice(0, 3000),
      blocks: alertBlocks(text, { orgId, component, category }),
      unfurl_links: false,
    };

    let result;
    try {
      result = await client.chat.postMessage(message);
    } catch (error) {
      if (slackErrorCode(error) !== 'not_in_channel') throw error;
      const membership = await ensureInChannel(client, channel);
      if (membership !== 'joined') {
        console.warn(`[Slack] Not in alert channel ${channel} (${membership}); someone must /invite @AuditDelta`);
        continue;
      }
      result = await client.chat.postMessage(message);
    }

    if (!threadTs && result.ts) {
      await authService.setCachedValue(threadKey, result.ts, THREAD_TTL_SEC);
    }
    delivered = true;
  }
  return delivered;
}

/** One-time notice when Salesforce access is lost: alert channel, or a DM to whoever linked the org. */
export async function notifyReauthRequired(orgId: string, reason: string): Promise<void> {
  for (const link of await slackDb().getSlackLinksForOrg(orgId)) {
    const client = await slackClientForTeam(link.team_id);
    const channel = link.alert_channel_id ?? link.linked_by;
    if (!client || !channel) continue;
    await client.chat.postMessage({
      channel,
      text:
        `:warning: *AuditDelta lost access to Salesforce org \`${orgId}\`* (${reason}).\n` +
        'Change monitoring and questions about this org are paused. Run `/auditdelta connect` here to reconnect.',
    });
  }
}
