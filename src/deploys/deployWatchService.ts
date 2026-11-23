/**
 * Deploy Watch: follows every deployment/validation in connected orgs (CLI, CI, DevOps Center,
 * change sets — anything that creates a DeployRequest) and shows it live in the org's Slack
 * deploy channel. Salesforce has no push event for deploys, so new deploys are discovered every
 * few seconds and running ones are refreshed every LIVE tick: one Slack message that updates in
 * place (clock, progress, live feed, Cancel / Quick deploy buttons), then the final status, with an
 * AI explanation of failures in the thread.
 */

import type { KnownBlock } from '@slack/types';
import { webApi } from '@slack/bolt';
import type { Connection } from 'jsforce';
import { authService, getDatabase } from '../services/container';
import { slackDb } from '../slack/store';
import { slackClientForTeam } from '../slack/app';
import {
  DeploySnapshot,
  FINAL_STATUSES,
  FeedEntry,
  elapsedClock,
  explainFailure,
  fetchDetails,
  fetchLiveFeed,
  getDeploy,
  headline,
  progressLines,
  queryDeploys,
  quickDeployable,
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

interface ActiveDeploy {
  orgId: string;
  deployId: string;
  targets: Array<{ teamId: string; channel: string }>;
  state: WatchState | null;
  ticks: number;
  discoveredAt: number;
  feed: { entries: FeedEntry[]; failures: FeedEntry[] };
}

const STATE_RETENTION_DAYS = 3;
const LOOKBACK_MS = 6 * 60 * 60 * 1000;
const SINCE_JOB = 'deploy_watch_since';
const PRUNE_EVERY_MS = 6 * 60 * 60 * 1000;
const FEED_LINES = 6;
/** Above this many concurrent deploys, refresh less often to stay within Slack rate limits. */
const BUSY_THRESHOLD = 4;

export class DeployWatchService {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private lastPrune = 0;
  private lastDiscovery = 0;
  private active = new Map<string, ActiveDeploy>();

  constructor(
    private readonly liveSec = 3,
    private readonly discoverSec = 10
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.liveSec * 1000);
    console.log(`[DeployWatch] Live: discovery every ${this.discoverSec}s, running deploys refreshed every ${this.liveSec}s`);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      if (Date.now() - this.lastPrune > PRUNE_EVERY_MS) {
        this.lastPrune = Date.now();
        await getDatabase().pruneDeployWatchState(STATE_RETENTION_DAYS).catch((error) => console.error('[DeployWatch] Prune failed:', error));
      }
      if (Date.now() - this.lastDiscovery >= this.discoverSec * 1000) {
        this.lastDiscovery = Date.now();
        for (const orgId of await authService.getAllOrgIds()) {
          if (await authService.isReauthRequired(orgId)) continue;
          await this.discover(orgId).catch((error) => console.error(`[DeployWatch] Discovery failed for ${orgId}:`, error?.message ?? error));
        }
      }
      const busy = this.active.size > BUSY_THRESHOLD;
      for (const deploy of [...this.active.values()]) {
        // Just posted by discovery in this tick; refresh it next tick.
        if (deploy.discoveredAt === this.lastDiscovery) continue;
        deploy.ticks++;
        if (busy && deploy.ticks % 2 === 1) continue;
        await this.refresh(deploy).catch((error) => console.error(`[DeployWatch] Refresh failed for ${deploy.deployId}:`, error?.message ?? error));
      }
    } finally {
      this.running = false;
    }
  }

  private async discover(orgId: string): Promise<void> {
    const links = (await slackDb().getSlackLinksForOrg(orgId)).filter((l) => l.deploy_channel_id);
    if (links.length === 0) return;
    const targets = links.map((l) => ({ teamId: l.team_id, channel: l.deploy_channel_id as string }));

    // Deploys that finished before watching started are history, not news. Kept in Postgres
    // (Heroku Redis has no persistence); the Redis read is a one-time migration.
    const db = getDatabase();
    let since = (await db.getJobState(orgId, SINCE_JOB)) ?? (await authService.getCachedValue(`deploy_watch_since:${orgId}`));
    if (!since) since = new Date().toISOString();
    await db.setJobState(orgId, SINCE_JOB, since);

    const conn = await authService.getConnection(orgId);
    const lookback = new Date(Date.now() - LOOKBACK_MS).toISOString().replace(/\.\d{3}Z$/, 'Z');
    for (const deploy of await queryDeploys(conn, lookback)) {
      const key = `${orgId}:${deploy.id}`;
      if (this.active.has(key)) continue;
      const state = await db.getDeployWatchState<WatchState>(orgId, deploy.id);
      if (state?.final) continue;
      if (!state && FINAL_STATUSES.has(deploy.status) && (deploy.completedDate ?? deploy.createdDate) < since) continue;
      const entry: ActiveDeploy = { orgId, deployId: deploy.id, targets, state, ticks: 0, discoveredAt: this.lastDiscovery, feed: { entries: [], failures: [] } };
      this.active.set(key, entry);
      await this.refresh(entry, deploy, conn);
    }
  }

  private async refresh(entry: ActiveDeploy, known?: DeploySnapshot, knownConn?: Connection): Promise<void> {
    const conn = knownConn ?? (await authService.getConnection(entry.orgId));
    const deploy = known ?? (await getDeploy(conn, entry.deployId));
    if (!deploy) {
      this.active.delete(`${entry.orgId}:${entry.deployId}`);
      return;
    }
    const isFinal = FINAL_STATUSES.has(deploy.status);
    // Per-component results: every other tick while running (they're heavier), always at the end.
    if (isFinal || entry.ticks % 2 === 0) {
      entry.feed = await fetchLiveFeed(conn, deploy.id).catch(() => entry.feed);
    }

    const blocks = messageBlocks(deploy, conn.instanceUrl, entry.feed, entry.orgId, entry.ticks);
    const text = headline(deploy).replace(/[*:]/g, '');
    const messages: PostedMessage[] = [];
    for (const target of entry.targets) {
      const client = await slackClientForTeam(target.teamId);
      if (!client) continue;
      const existing = entry.state?.messages.find((m) => m.teamId === target.teamId && m.channel === target.channel);
      try {
        if (existing) {
          await client.chat.update({ channel: existing.channel, ts: existing.ts, blocks, text });
          messages.push(existing);
        } else {
          const posted = await client.chat.postMessage({ channel: target.channel, blocks, text, unfurl_links: false });
          if (posted.ts) messages.push({ teamId: target.teamId, channel: target.channel, ts: posted.ts });
        }
      } catch (error) {
        console.error(`[DeployWatch] Slack update failed for ${deploy.id}:`, (error as { data?: { error?: string } }).data?.error ?? error);
        if (existing) messages.push(existing);
      }
    }

    entry.state = { messages, fingerprint: `${deploy.status}|${deploy.componentsDeployed}|${deploy.testsCompleted}`, final: isFinal };
    await getDatabase().saveDeployWatchState(entry.orgId, deploy.id, entry.state);
    if (!isFinal) return;

    this.active.delete(`${entry.orgId}:${entry.deployId}`);
    console.log(`[DeployWatch] ${deploy.id} ${deploy.status} (${deploy.checkOnly ? 'validation' : 'deploy'}) by ${deploy.createdByName}`);
    if (deploy.status !== 'Failed' && deploy.status !== 'SucceededPartial') return;
    await this.explainInThread(conn, deploy, messages);
  }

  private async explainInThread(conn: Connection, deploy: DeploySnapshot, messages: PostedMessage[]): Promise<void> {
    const details = await fetchDetails(conn, deploy.id).catch((error) => {
      console.error(`[DeployWatch] Details failed for ${deploy.id}:`, error?.message ?? error);
      return null;
    });
    const analysis = details ? await explainFailure(conn, deploy, details) : deploy.errorMessage ?? 'Salesforce did not return failure details.';
    const kind = deploy.checkOnly ? 'validation' : 'deployment';
    for (const message of messages) {
      const client = await slackClientForTeam(message.teamId);
      if (!client) continue;
      const mention = await this.deployerMention(client, conn, deploy.createdById);
      const body = `${mention ? `${mention}, your ${kind} failed.\n\n` : ''}${analysis}`;
      await client.chat
        .postMessage({ channel: message.channel, thread_ts: message.ts, text: body.slice(0, 3000), blocks: sections(body), unfurl_links: false })
        .catch((error) => console.error(`[DeployWatch] Thread reply failed for ${deploy.id}:`, error?.data?.error ?? error));
    }
  }

  /** <@U…> for the Salesforce user who started the deploy, matched by email; null if unknown. */
  private async deployerMention(client: SlackClient, conn: Connection, userId: string): Promise<string | null> {
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

function feedLines(feed: ActiveDeploy['feed'], isFinal: boolean): string[] {
  // At the end, failures matter more than the last successes.
  const shown = isFinal && feed.failures.length ? feed.failures.slice(0, FEED_LINES) : feed.entries.slice(0, FEED_LINES);
  const lines = shown.map((e) => `${e.ok ? ':white_check_mark:' : ':x:'} \`${e.label}\``);
  const hidden = (isFinal && feed.failures.length ? feed.failures.length : feed.entries.length) - shown.length;
  if (hidden > 0) lines.push(`_…and ${hidden} more_`);
  return lines;
}

function messageBlocks(d: DeploySnapshot, instanceUrl: string, feed: ActiveDeploy['feed'], orgId: string, tick: number): KnownBlock[] {
  const isFinal = FINAL_STATUSES.has(d.status);
  const kind = d.checkOnly ? 'Validation' : 'Deployment';
  // The alternating hourglass and the ticking clock make it visibly live.
  const title = isFinal
    ? `${headline(d)}`
    : `${tick % 2 === 0 ? ':hourglass_flowing_sand:' : ':hourglass:'} *${kind} ${d.status === 'Pending' ? 'queued' : d.status === 'Canceling' ? 'canceling' : 'in progress'}* · :stopwatch: ${elapsedClock(d)}`;
  const blocks: KnownBlock[] = [
    { type: 'section', text: { type: 'mrkdwn', text: `${title}\n${progressLines(d).filter((l) => !l.startsWith('_')).join('\n')}` } },
  ];
  if (!isFinal && d.stateDetail) {
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `*Now:* ${d.stateDetail}` }] });
  }
  const lines = feedLines(feed, isFinal);
  if (lines.length) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: lines.join('\n') } });

  const value = JSON.stringify({ o: orgId, d: d.id });
  if (!isFinal) {
    blocks.push({
      type: 'actions',
      block_id: 'deploy_actions',
      elements: [{
        type: 'button', style: 'danger', action_id: 'auditdelta_deploy_cancel', value,
        text: { type: 'plain_text', text: `Cancel ${kind.toLowerCase()}` },
        confirm: {
          title: { type: 'plain_text', text: `Cancel this ${kind.toLowerCase()}?` },
          text: { type: 'mrkdwn', text: `Salesforce stops \`${d.id}\` and rolls back anything already deployed.` },
          confirm: { type: 'plain_text', text: 'Cancel it' },
          deny: { type: 'plain_text', text: 'Keep running' },
        },
      }],
    });
  } else if (quickDeployable(d)) {
    blocks.push({
      type: 'actions',
      block_id: 'deploy_actions',
      elements: [{
        type: 'button', style: 'primary', action_id: 'auditdelta_deploy_quick', value,
        text: { type: 'plain_text', text: 'Quick deploy' },
        confirm: {
          title: { type: 'plain_text', text: 'Quick deploy this validation?' },
          text: { type: 'mrkdwn', text: `Deploys the validated components of \`${d.id}\` to the org now, without re-running tests.` },
          confirm: { type: 'plain_text', text: 'Deploy' },
          deny: { type: 'plain_text', text: 'Not now' },
        },
      }],
    });
  }

  const context = [
    `by *${d.createdByName}*`,
    d.changeSetName ? `change set *${d.changeSetName}*` : null,
    d.testLevel ? `tests: ${d.testLevel}` : null,
    `<${instanceUrl}/lightning/setup/DeployStatus/home|\`${d.id}\`>`,
  ].filter(Boolean);
  blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `AuditDelta Deploy Watch · ${context.join(' · ')}` }] });
  return blocks;
}
