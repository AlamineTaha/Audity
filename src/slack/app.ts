import { App, ExpressReceiver, BlockAction, ButtonAction, webApi } from '@slack/bolt';
import type { KnownBlock } from '@slack/types';
import { resolveTenant } from '../middleware/tenantAuth';
import { authService } from '../services/container';
import { getTool } from '../tools';
import { TenantContext } from '../types';
import { loadConversation, runAgent, runTool, saveConversation, savePendingAction, takePendingAction, PendingAction } from './agent';
import { AlertRef, confirmationBlocks, contextBlock, markdownBlock } from './blocks';
import { botTokenForTeam, installationStore, slackDb } from './store';

type SlackClient = webApi.WebClient;

export const SLACK_BOT_SCOPES = [
  'assistant:write',
  'app_mentions:read',
  'channels:history',
  'channels:join',
  'chat:write',
  'commands',
  'groups:history',
  'im:history',
  'im:write',
];

const baseUrl = () => process.env.API_BASE_URL || `http://localhost:${process.env.PORT || 3000}`;

async function tenantForTeam(teamId: string): Promise<TenantContext | null> {
  const links = await slackDb().getSlackLinksForTeam(teamId);
  const link = links.find((l) => l.is_default) ?? links[0];
  if (!link) return null;
  const result = await resolveTenant({ kind: 'orgId', orgId: link.org_id }, `slack:${teamId}`);
  return result.ok ? result.tenant : null;
}

async function setSessionStatus(client: SlackClient, channel: string, threadTs: string, status: 'processing' | 'active') {
  try {
    await client.agents.sessions.setStatus({ channel_id: channel, thread_ts: threadTs, status });
  } catch {
    // Only agent-view DMs have sessions; channel threads don't.
  }
}

/** Runs one agent turn for a Slack message and posts the reply into the thread. */
async function handleUserMessage(params: {
  client: SlackClient;
  teamId: string;
  channel: string;
  threadTs: string;
  userId: string;
  text: string;
}): Promise<void> {
  const { client, teamId, channel, threadTs, userId, text } = params;
  const tenant = await tenantForTeam(teamId);
  if (!tenant) {
    await client.chat.postMessage({
      channel,
      thread_ts: threadTs,
      text: 'No Salesforce org is connected to this workspace yet. Run `/auditdelta connect` to connect one.',
    });
    return;
  }

  await setSessionStatus(client, channel, threadTs, 'processing');
  try {
    const history = await loadConversation(teamId, channel, threadTs);
    const reply = await runAgent(tenant, history, text, userId, baseUrl());
    await saveConversation(teamId, channel, threadTs, history);

    const blocks: KnownBlock[] = [markdownBlock(reply.text)];
    for (const action of reply.pendingActions) {
      blocks.push(...confirmationBlocks(action, getTool(action.toolName)?.title ?? action.toolName));
    }
    await client.chat.postMessage({ channel, thread_ts: threadTs, text: reply.text.slice(0, 3000), blocks });
  } catch (error) {
    console.error('[Slack] Agent turn failed:', error);
    await client.chat.postMessage({
      channel,
      thread_ts: threadTs,
      text: `Sorry, something went wrong: ${error instanceof Error ? error.message : 'unknown error'}`,
    });
  } finally {
    await setSessionStatus(client, channel, threadTs, 'active');
  }
}

const HELP = [
  '*AuditDelta* — Salesforce change governance in Slack.',
  '• `/auditdelta connect [sandbox|https://yourdomain.my.salesforce.com]` — connect a Salesforce org',
  '• `/auditdelta alerts here` — send change alerts to this channel',
  '• `/auditdelta status` — show connected orgs and alert channels',
  '• `/auditdelta disconnect` — disconnect the default org from this workspace',
  'Then just DM me or @mention me: _"What changed in the last 24 hours?"_, _"Who can export reports?"_, _"Compare the last two versions of Lead_Routing"_.',
].join('\n');

function registerListeners(app: App): void {
  // Direct messages (agent view) — every top-level message starts or continues a thread session.
  app.message(async ({ message, client, context }) => {
    if (message.channel_type !== 'im' || message.subtype !== undefined || !('text' in message) || !message.text) return;
    if (!context.teamId) return;
    await handleUserMessage({
      client,
      teamId: context.teamId,
      channel: message.channel,
      threadTs: message.thread_ts ?? message.ts,
      userId: message.user,
      text: message.text,
    });
  });

  app.event('app_mention', async ({ event, client, context }) => {
    if (!context.teamId || !event.user) return;
    const text = event.text.replace(/<@[A-Z0-9]+>/g, '').trim();
    await handleUserMessage({
      client,
      teamId: context.teamId,
      channel: event.channel,
      threadTs: event.thread_ts ?? event.ts,
      userId: event.user,
      text: text || 'Hi',
    });
  });

  app.command('/auditdelta', async ({ command, ack, respond, client }) => {
    await ack();
    const [sub = 'help', ...rest] = command.text.trim().split(/\s+/).filter(Boolean);
    const teamId = command.team_id;

    switch (sub.toLowerCase()) {
      case 'connect': {
        try {
          const url = await authService.startAuthorization({
            loginUrl: rest[0],
            slackLink: { teamId, userId: command.user_id, channelId: command.channel_id },
          });
          await respond({
            response_type: 'ephemeral',
            text: 'Connect your Salesforce org',
            blocks: [
              { type: 'section', text: { type: 'mrkdwn', text: 'Sign in to Salesforce to connect your org. The link works once and expires in 10 minutes.' } },
              { type: 'actions', elements: [{ type: 'button', style: 'primary', text: { type: 'plain_text', text: 'Connect Salesforce' }, url, action_id: 'auditdelta_connect_link' }] },
            ],
          });
        } catch (error) {
          await respond({ response_type: 'ephemeral', text: `Could not start sign-in: ${error instanceof Error ? error.message : error}` });
        }
        return;
      }
      case 'alerts': {
        const links = await slackDb().getSlackLinksForTeam(teamId);
        const link = links.find((l) => l.is_default) ?? links[0];
        if (!link) {
          await respond({ response_type: 'ephemeral', text: 'Connect an org first with `/auditdelta connect`.' });
          return;
        }
        if (command.channel_id.startsWith('C')) {
          try {
            await client.conversations.join({ channel: command.channel_id });
          } catch {
            // Private channels need a manual /invite.
          }
        }
        await slackDb().setSlackAlertChannel(teamId, link.org_id, command.channel_id);
        await respond({ response_type: 'in_channel', text: `:bell: Change alerts for org \`${link.org_id}\` will be posted in this channel.` });
        return;
      }
      case 'status': {
        const links = await slackDb().getSlackLinksForTeam(teamId);
        const text = links.length
          ? links.map((l) => `• \`${l.org_id}\`${l.is_default ? ' (default)' : ''} — alerts: ${l.alert_channel_id ? `<#${l.alert_channel_id}>` : '_not set_'}`).join('\n')
          : 'No org connected. Run `/auditdelta connect`.';
        await respond({ response_type: 'ephemeral', text });
        return;
      }
      case 'disconnect': {
        const links = await slackDb().getSlackLinksForTeam(teamId);
        const link = links.find((l) => l.is_default) ?? links[0];
        if (link) await slackDb().unlinkSlackOrg(teamId, link.org_id);
        await respond({ response_type: 'ephemeral', text: link ? `Disconnected org \`${link.org_id}\`.` : 'No org was connected.' });
        return;
      }
      default:
        await respond({ response_type: 'ephemeral', text: HELP });
    }
  });

  app.action('auditdelta_connect_link', async ({ ack }) => {
    await ack();
  });

  app.action<BlockAction<ButtonAction>>('auditdelta_confirm', async ({ ack, body, action, client, respond }) => {
    await ack();
    const pending = await takePendingAction(action.value ?? '');
    if (!pending) {
      await respond({ response_type: 'ephemeral', replace_original: false, text: 'This action has expired or was already handled.' });
      return;
    }
    if (pending.requestedBy !== body.user.id) {
      await savePendingAction(pending);
      await respond({ response_type: 'ephemeral', replace_original: false, text: `Only <@${pending.requestedBy}> can confirm this action.` });
      return;
    }
    await resolvePendingAction(client, body, pending, true);
  });

  app.action<BlockAction<ButtonAction>>('auditdelta_cancel', async ({ ack, body, action, client }) => {
    await ack();
    const pending = await takePendingAction(action.value ?? '');
    if (pending) await resolvePendingAction(client, body, pending, false);
  });

  app.action<BlockAction<ButtonAction>>('auditdelta_explain', async ({ ack, body, action, client, context }) => {
    await ack();
    const ref = JSON.parse(action.value ?? '{}') as AlertRef;
    const channel = body.channel?.id;
    const threadTs = body.message?.thread_ts ?? body.message?.ts;
    if (!channel || !threadTs || !context.teamId) return;
    await handleUserMessage({
      client,
      teamId: context.teamId,
      channel,
      threadTs,
      userId: body.user.id,
      text: `Explain the ${ref.category} change to "${ref.component}" that this alert is about: what changed, who is affected, and the risk. Use the tools to check the actual metadata.`,
    });
  });

  app.action<BlockAction<ButtonAction>>('auditdelta_ack', async ({ ack, body, client }) => {
    await ack();
    const channel = body.channel?.id;
    const ts = body.message?.ts;
    if (!channel || !ts) return;
    const blocks = ((body.message?.blocks ?? []) as KnownBlock[]).filter((b) => b.block_id !== 'alert_actions');
    blocks.push(contextBlock(`:white_check_mark: Acknowledged by <@${body.user.id}> · <!date^${Math.floor(Date.now() / 1000)}^{date_short_pretty} {time}|now>`));
    await client.chat.update({ channel, ts, blocks, text: body.message?.text ?? 'Acknowledged' });
  });
}

async function resolvePendingAction(client: SlackClient, body: BlockAction, pending: PendingAction, confirmed: boolean) {
  const channel = body.channel?.id;
  const message = body.message;
  const title = getTool(pending.toolName)?.title ?? pending.toolName;

  if (channel && message?.ts) {
    const blocks = ((message.blocks ?? []) as KnownBlock[]).filter((b) => b.block_id !== `confirm_${pending.id}`);
    blocks.push(contextBlock(confirmed ? `:hourglass: *${title}* confirmed by <@${body.user.id}>` : `:x: *${title}* cancelled by <@${body.user.id}>`));
    await client.chat.update({ channel, ts: message.ts, blocks, text: message.text ?? title });
  }
  if (!confirmed || !channel) return;

  const tenant = await resolveTenant({ kind: 'orgId', orgId: pending.orgId }, `slack-action:${pending.toolName}`);
  const result = tenant.ok
    ? await runTool({ tenant: tenant.tenant, source: 'slack', actor: body.user.id, baseUrl: baseUrl() }, pending.toolName, pending.args)
    : { success: false, error: tenant.error };
  const text = String(result.displayText ?? result.error ?? (result.success ? 'Done.' : 'Failed.'));
  await client.chat.postMessage({
    channel,
    thread_ts: message?.thread_ts ?? message?.ts,
    text,
    blocks: [markdownBlock(`${result.success ? ':white_check_mark:' : ':x:'} *${title}*\n\n${text}`)],
  });
}

/** Called after the Salesforce OAuth callback when sign-in was started from `/auditdelta connect`. */
export async function onSalesforceConnectedFromSlack(link: { teamId: string; userId: string; channelId?: string }, orgId: string) {
  const alertChannel = link.channelId && /^[CG]/.test(link.channelId) ? link.channelId : undefined;
  await slackDb().linkSlackOrg(link.teamId, orgId, link.userId, alertChannel);
  const token = await botTokenForTeam(link.teamId);
  if (!token) return;
  const client = new webApi.WebClient(token);
  await client.chat.postMessage({
    channel: link.userId,
    text:
      `:white_check_mark: Salesforce org \`${orgId}\` is connected.` +
      (alertChannel ? ` Change alerts will go to <#${alertChannel}>.` : ' Run `/auditdelta alerts here` in a channel to receive change alerts.') +
      ' Ask me anything about your org’s configuration changes.',
  });
}

/**
 * Builds the Bolt receiver. Multi-workspace OAuth when SLACK_CLIENT_ID/SECRET are set,
 * otherwise single-workspace with SLACK_BOT_TOKEN. Returns null when Slack isn't configured.
 */
export function createSlackReceiver(): ExpressReceiver | null {
  const signingSecret = process.env.SLACK_SIGNING_SECRET;
  if (!signingSecret) return null;

  const clientId = process.env.SLACK_CLIENT_ID;
  const clientSecret = process.env.SLACK_CLIENT_SECRET;
  const oauth = Boolean(clientId && clientSecret);
  if (!oauth && !process.env.SLACK_BOT_TOKEN) {
    console.warn('[Slack] SLACK_SIGNING_SECRET is set but neither SLACK_CLIENT_ID/SECRET nor SLACK_BOT_TOKEN; Slack disabled');
    return null;
  }

  const receiver = new ExpressReceiver({
    signingSecret,
    endpoints: '/slack/events',
    ...(oauth
      ? {
          clientId,
          clientSecret,
          stateSecret: process.env.SLACK_STATE_SECRET || signingSecret,
          scopes: SLACK_BOT_SCOPES,
          installationStore,
          installerOptions: { installPath: '/slack/install', redirectUriPath: '/slack/oauth_redirect', directInstall: true },
        }
      : {}),
  });
  const app = new App({ receiver, deferInitialization: true, ...(oauth ? {} : { token: process.env.SLACK_BOT_TOKEN }) });
  registerListeners(app);
  // A bad token must not take the API down; Slack features stay unavailable until fixed.
  app.init().catch((error) => console.error('[Slack] Initialization failed (check SLACK_BOT_TOKEN):', error?.data?.error ?? error));
  app.error(async (error) => {
    console.error('[Slack] Unhandled Bolt error:', error);
  });
  console.log(`[Slack] Enabled (${oauth ? 'multi-workspace OAuth' : 'single workspace'})`);
  return receiver;
}

export async function slackClientForTeam(teamId: string): Promise<SlackClient | null> {
  const token = await botTokenForTeam(teamId);
  return token ? new webApi.WebClient(token) : null;
}
