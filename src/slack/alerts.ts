import { authService } from '../services/container';
import { slackClientForTeam } from './app';
import { alertBlocks } from './blocks';
import { slackDb } from './store';

const THREAD_TTL_SEC = 36 * 60 * 60;

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
    if (!client || !link.alert_channel_id) continue;

    const threadKey = `slack_alert_thread:${link.team_id}:${orgId}:${component}`;
    const threadTs = await authService.getCachedValue(threadKey);
    const result = await client.chat.postMessage({
      channel: link.alert_channel_id,
      thread_ts: threadTs ?? undefined,
      text: text.slice(0, 3000),
      blocks: alertBlocks(text, { orgId, component, category }),
      unfurl_links: false,
    });
    if (!threadTs && result.ts) {
      await authService.setCachedValue(threadKey, result.ts, THREAD_TTL_SEC);
    }
    delivered = true;
  }
  return delivered;
}
