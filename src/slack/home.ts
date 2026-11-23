/**
 * App Home dashboard: what a team sees when it opens AuditDelta in Slack.
 */

import type { App } from '@slack/bolt';
import type { KnownBlock } from '@slack/types';
import { resolveTenant } from '../middleware/tenantAuth';
import { authService, getDatabase } from '../services/container';
import { loadChangeHotspots } from '../services/insightsService';
import { queryDeploys, DeploySnapshot } from '../deploys/deployAnalysis';
import { runTool } from './agent';
import { context, header } from './design';
import { slackDb } from './store';

const baseUrl = () => process.env.API_BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
const ago = (iso: string) => {
  const min = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  return min < 60 ? `${min}m ago` : min < 1440 ? `${Math.round(min / 60)}h ago` : `${Math.round(min / 1440)}d ago`;
};
const bar = (value: number, max: number) => '▇'.repeat(Math.max(1, Math.round((value / Math.max(max, 1)) * 12)));
const STATUS_ICON: Record<string, string> = {
  Succeeded: ':white_check_mark:',
  SucceededPartial: ':warning:',
  Failed: ':x:',
  Canceled: ':no_entry_sign:',
  Canceling: ':no_entry_sign:',
  InProgress: ':hourglass_flowing_sand:',
  Pending: ':hourglass:',
};

async function orgName(orgId: string): Promise<{ name: string; instanceUrl: string } | null> {
  const cacheKey = `home_org_name:${orgId}`;
  const cached = await authService.getCachedValue(cacheKey);
  if (cached) return JSON.parse(cached);
  try {
    const conn = await authService.getConnection(orgId);
    const r = await conn.query<{ Name: string }>('SELECT Name FROM Organization LIMIT 1');
    const value = { name: r.records[0]?.Name ?? orgId, instanceUrl: conn.instanceUrl };
    await authService.setCachedValue(cacheKey, JSON.stringify(value), 24 * 60 * 60);
    return value;
  } catch {
    return null;
  }
}

async function orgSection(link: { org_id: string; alert_channel_id: string | null; deploy_channel_id: string | null }): Promise<KnownBlock[]> {
  const orgId = link.org_id;
  const needsReauth = await authService.isReauthRequired(orgId);
  const info = needsReauth ? null : await orgName(orgId);
  const blocks: KnownBlock[] = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*${info?.name ?? 'Salesforce org'}*  \`${orgId}\`\n${needsReauth ? ':warning: *Reconnect needed* — run `/auditdelta connect`' : ':large_green_circle: Connected'}${info ? `  ·  <${info.instanceUrl}|Open org>` : ''}`,
      },
      ...(needsReauth
        ? {}
        : { accessory: { type: 'button' as const, style: 'primary' as const, text: { type: 'plain_text' as const, text: 'Run a check now' }, action_id: 'auditdelta_home_check', value: orgId } }),
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Change alerts*\n${link.alert_channel_id ? `<#${link.alert_channel_id}>` : '_off — `/auditdelta alerts here`_'}` },
        { type: 'mrkdwn', text: `*Deploy Watch*\n${link.deploy_channel_id ? `<#${link.deploy_channel_id}>` : '_off — `/auditdelta deploys here`_'}` },
      ],
    },
  ];
  if (needsReauth) return blocks;

  // Last 7 days: archive-based numbers and live recent deploys. Each part degrades on its own.
  const [hotspots, privileged, deploys] = await Promise.all([
    loadChangeHotspots(orgId, 7, undefined, 4).catch(() => null),
    getDatabase().getPrivilegedAccess(orgId).catch(() => []),
    recentDeploys(orgId).catch(() => [] as DeploySnapshot[]),
  ]);
  const admins = new Set(privileged.filter((g) => ['PermissionsModifyAllData', 'PermissionsViewAllData', 'PermissionsModifyMetadata'].includes(g.permission)).map((g) => g.user_id)).size;
  blocks.push({
    type: 'section',
    fields: [
      { type: 'mrkdwn', text: `*Change sessions · 7d*\n${hotspots ? hotspots.totalChanges : '—'}` },
      { type: 'mrkdwn', text: `*Components changed · 7d*\n${hotspots ? hotspots.hotspots.length : '—'}${hotspots && hotspots.hotspots.length >= 4 ? '+' : ''}` },
      { type: 'mrkdwn', text: `*Users with admin-level data access*\n${admins}` },
      { type: 'mrkdwn', text: `*Deployments · 7d*\n${deploys.length}${deploys.length >= 5 ? '+' : ''}` },
    ],
  });
  if (hotspots?.hotspots.length) {
    const max = hotspots.hotspots[0].changes;
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Hotspots*\n${hotspots.hotspots.map((h) => `\`${bar(h.changes, max)}\`  *${h.component}*  ·  ${h.category}  ·  ${h.changes} session${h.changes === 1 ? '' : 's'}`).join('\n')}`,
      },
    });
  }
  if (deploys.length) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Recent deployments*\n${deploys
          .map((d) => `${STATUS_ICON[d.status] ?? ':grey_question:'}  ${d.checkOnly ? 'Validation' : 'Deployment'} by ${d.createdByName}  ·  ${d.componentsTotal} component(s)  ·  ${ago(d.createdDate)}`)
          .join('\n')}`,
      },
    });
  }
  return blocks;
}

async function recentDeploys(orgId: string): Promise<DeploySnapshot[]> {
  const conn = await authService.getConnection(orgId);
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const all = await queryDeploys(conn, since, 200);
  return all.slice(-5).reverse();
}

export async function homeView(teamId: string): Promise<KnownBlock[]> {
  const links = await slackDb().getSlackLinksForTeam(teamId);
  const blocks: KnownBlock[] = [
    header('AuditDelta'),
    context('Salesforce change governance, in Slack', 'DM me or @mention me with any question about your org'),
    { type: 'divider' },
  ];
  if (links.length === 0) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: '*Get started*\nRun `/auditdelta connect` in the channel where you want change alerts — it opens the Salesforce sign-in and links your org to this workspace.' },
    });
    return blocks;
  }
  for (const link of links) {
    blocks.push(...(await orgSection(link)), { type: 'divider' });
  }
  blocks.push(
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '*Try asking*\n• _Who owns AD_Test_Lead_Routing?_\n• _Which flows changed the most this month?_\n• _Who has Modify All Data?_\n• _Why did the last deploy fail?_',
      },
    },
    context(`Updated <!date^${Math.floor(Date.now() / 1000)}^{date_short_pretty} {time}|now>`, '`/auditdelta help` for commands')
  );
  return blocks.slice(0, 100);
}

export function registerHome(app: App): void {
  app.event('app_home_opened', async ({ event, client, context: ctx }) => {
    if (event.tab !== 'home' || !ctx.teamId) return;
    const blocks = await homeView(ctx.teamId).catch((error) => {
      console.error('[Slack] App Home failed:', error);
      return [header('AuditDelta'), context('Could not load the dashboard right now — try again in a minute.')];
    });
    await client.views.publish({ user_id: event.user, view: { type: 'home', blocks } });
  });

  app.action('auditdelta_home_check', async ({ ack, body, action, client, context: ctx }) => {
    await ack();
    const orgId = (action as { value?: string }).value;
    if (!orgId || !ctx.teamId) return;
    const linked = (await slackDb().getSlackLinksForTeam(ctx.teamId)).some((l) => l.org_id === orgId);
    if (!linked) return;
    const tenant = await resolveTenant({ kind: 'orgId', orgId }, 'slack-home');
    if (!tenant.ok) return;
    const result = await runTool({ tenant: tenant.tenant, source: 'slack', actor: body.user.id, baseUrl: baseUrl() }, 'run_change_check', {});
    // Report in a DM; the dashboard itself refreshes next time the tab opens.
    await client.chat.postMessage({ channel: body.user.id, text: String(result.displayText ?? result.error ?? 'Check finished.').slice(0, 3000) });
    await client.views.publish({ user_id: body.user.id, view: { type: 'home', blocks: await homeView(ctx.teamId) } });
  });
}

