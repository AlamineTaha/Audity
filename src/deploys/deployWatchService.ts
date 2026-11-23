/**
 * Deploy Watch: follows every deployment/validation in connected orgs (CLI, CI, DevOps Center,
 * change sets — anything that creates a DeployRequest) and reports it in the org's Slack deploy
 * channel: one message that updates with live progress, then the final status, with an AI
 * explanation of failures in the thread.
 */

import type { KnownBlock } from '@slack/types';
import { webApi } from '@slack/bolt';
import { authService } from '../services/container';
import { slackDb } from '../slack/store';
import { slackClientForTeam } from '../slack/app';
import {
  DeploySnapshot,
  FINAL_STATUSES,
  explainFailure,
  fetchDetails,
  headline,
  progressLines,
  queryDeploys,
} from './deployAnalysis';

type SlackClient = webApi.WebClient;

interface PostedMessage {
  teamId: string;
  channel: string;
  ts: string;
}

interface WatchState {
  messages: PostedMessage[];
  fingerprint: string;
  final: boolean;
}

const STATE_TTL_SEC = 3 * 24 * 60 * 60;
const LOOKBACK_MS = 6 * 60 * 60 * 1000;
const stateKey = (orgId: string, id: string) => `deploy_watch:${orgId}:${id}`;
const sinceKey = (orgId: string) => `deploy_watch_since:${orgId}`;

const fingerprint = (d: DeploySnapshot) =>
  [d.status, d.componentsDeployed, d.componentErrors, d.testsCompleted, d.testErrors, d.stateDetail ?? ''].join('|');

export class DeployWatchService {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  start(intervalSec: number): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), intervalSec * 1000);
    console.log(`[DeployWatch] Watching deployments every ${intervalSec}s`);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (const orgId of await authService.getAllOrgIds()) {
        if (await authService.isReauthRequired(orgId)) continue;
        await this.checkOrg(orgId).catch((error) => console.error(`[DeployWatch] Org ${orgId} failed:`, error?.message ?? error));
      }
    } finally {
      this.running = false;
    }
  }

  private async checkOrg(orgId: string): Promise<void> {
    const links = (await slackDb().getSlackLinksForOrg(orgId)).filter((l) => l.deploy_channel_id);
    if (links.length === 0) return;

    // Deploys that finished before watching started are history, not news.
    let since = await authService.getCachedValue(sinceKey(orgId));
    if (!since) {
      since = new Date().toISOString();
      await authService.setCachedValue(sinceKey(orgId), since, 365 * 24 * 60 * 60);
    }

    const conn = await authService.getConnection(orgId);
    const lookback = new Date(Date.now() - LOOKBACK_MS).toISOString().replace(/\.\d{3}Z$/, 'Z');
    for (const deploy of await queryDeploys(conn, lookback)) {
      const raw = await authService.getCachedValue(stateKey(orgId, deploy.id));
      const state: WatchState | null = raw ? JSON.parse(raw) : null;
      if (state?.final) continue;
      const isFinal = FINAL_STATUSES.has(deploy.status);
      if (!state && isFinal && (deploy.completedDate ?? deploy.createdDate) < since) continue;
      if (state && state.fingerprint === fingerprint(deploy) && !isFinal) continue;
      await this.report(orgId, conn, deploy, state, links.map((l) => ({ teamId: l.team_id, channel: l.deploy_channel_id as string })));
    }
  }

  private async report(
    orgId: string,
    conn: Awaited<ReturnType<typeof authService.getConnection>>,
    deploy: DeploySnapshot,
    previous: WatchState | null,
    targets: Array<{ teamId: string; channel: string }>
  ): Promise<void> {
    const isFinal = FINAL_STATUSES.has(deploy.status);
    const instanceUrl = conn.instanceUrl;
    const blocks = messageBlocks(deploy, instanceUrl);
    const text = headline(deploy).replace(/[*:]/g, '');
    const messages: PostedMessage[] = [];

    for (const target of targets) {
      const client = await slackClientForTeam(target.teamId);
      if (!client) continue;
      const existing = previous?.messages.find((m) => m.teamId === target.teamId && m.channel === target.channel);
      try {
        if (existing) {
          await client.chat.update({ channel: existing.channel, ts: existing.ts, blocks, text });
          messages.push(existing);
        } else {
          const posted = await client.chat.postMessage({ channel: target.channel, blocks, text, unfurl_links: false });
          if (posted.ts) messages.push({ teamId: target.teamId, channel: target.channel, ts: posted.ts });
        }
      } catch (error) {
        console.error(`[DeployWatch] Slack post failed for ${deploy.id}:`, (error as { data?: { error?: string } }).data?.error ?? error);
      }
    }

    const state: WatchState = { messages, fingerprint: fingerprint(deploy), final: isFinal };
    await authService.setCachedValue(stateKey(orgId, deploy.id), JSON.stringify(state), STATE_TTL_SEC);
    if (!isFinal || messages.length === 0) return;

    console.log(`[DeployWatch] ${deploy.id} ${deploy.status} (${deploy.checkOnly ? 'validation' : 'deploy'}) by ${deploy.createdByName}`);
    const failed = deploy.status === 'Failed' || deploy.status === 'SucceededPartial';
    let threadText: string | null = null;
    if (failed) {
      const details = await fetchDetails(conn, deploy.id).catch((error) => {
        console.error(`[DeployWatch] Details failed for ${deploy.id}:`, error?.message ?? error);
        return null;
      });
      threadText = details ? await explainFailure(conn, deploy, details) : deploy.errorMessage ?? 'Salesforce did not return failure details.';
    }

    // Successes stay quiet (the updated message says it all); failures get the analysis in the thread.
    if (!failed || !threadText) return;
    const kind = deploy.checkOnly ? 'validation' : 'deployment';
    for (const message of messages) {
      const client = await slackClientForTeam(message.teamId);
      if (!client) continue;
      const mention = await this.deployerMention(client, conn, deploy.createdById);
      const body = `${mention ? `${mention}, your ${kind} failed.\n\n` : ''}${threadText}`;
      await client.chat
        .postMessage({ channel: message.channel, thread_ts: message.ts, text: body.slice(0, 3000), blocks: sections(body), unfurl_links: false })
        .catch((error) => console.error(`[DeployWatch] Thread reply failed for ${deploy.id}:`, error?.data?.error ?? error));
    }
  }

  /** <@U…> for the Salesforce user who started the deploy, matched by email; null if unknown. */
  private async deployerMention(client: SlackClient, conn: Awaited<ReturnType<typeof authService.getConnection>>, userId: string): Promise<string | null> {
    const cacheKey = `deploy_watch_user:${userId}`;
    const cached = await authService.getCachedValue(cacheKey);
    if (cached) return cached === '-' ? null : `<@${cached}>`;
    let slackId: string | null = null;
    try {
      const user = await conn.query<{ Email: string }>(`SELECT Email FROM User WHERE Id = '${userId.replace(/'/g, "\\'")}' LIMIT 1`);
      const email = user.records[0]?.Email;
      if (email) slackId = (await client.users.lookupByEmail({ email })).user?.id ?? null;
    } catch {
      // No matching Slack user, or the app lacks users:read.email.
    }
    await authService.setCachedValue(cacheKey, slackId ?? '-', 24 * 60 * 60);
    return slackId ? `<@${slackId}>` : null;
  }
}

function sections(text: string): KnownBlock[] {
  const blocks: KnownBlock[] = [];
  for (let i = 0; i < text.length && blocks.length < 10; i += 2900) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: text.slice(i, i + 2900) } });
  }
  return blocks;
}

function messageBlocks(d: DeploySnapshot, instanceUrl: string): KnownBlock[] {
  const context = [
    `by *${d.createdByName}*`,
    d.changeSetName ? `change set *${d.changeSetName}*` : null,
    d.testLevel ? `tests: ${d.testLevel}` : null,
    `<${instanceUrl}/lightning/setup/DeployStatus/home|\`${d.id}\`>`,
  ].filter(Boolean);
  return [
    { type: 'section', text: { type: 'mrkdwn', text: `${headline(d)}\n${progressLines(d).join('\n')}` } },
    { type: 'context', elements: [{ type: 'mrkdwn', text: `AuditDelta Deploy Watch · ${context.join(' · ')}` }] },
  ];
}
