import type { KnownBlock } from '@slack/types';
import { PendingAction } from './agent';

const MARKDOWN_LIMIT = 12000;
const SECTION_LIMIT = 2900;

export function markdownBlock(text: string): KnownBlock {
  return {
    type: 'markdown',
    text: text.length > MARKDOWN_LIMIT ? `${text.slice(0, MARKDOWN_LIMIT - 20)}\n\n…(truncated)` : text,
  };
}

export function mrkdwnSections(text: string): KnownBlock[] {
  const blocks: KnownBlock[] = [];
  for (let i = 0; i < text.length && blocks.length < 10; i += SECTION_LIMIT) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: text.slice(i, i + SECTION_LIMIT) } });
  }
  return blocks;
}

export function contextBlock(text: string): KnownBlock {
  return { type: 'context', elements: [{ type: 'mrkdwn', text }] };
}

function describeArgs(args: Record<string, unknown>): string {
  return Object.entries(args).map(([k, v]) => `\`${k}\`: ${JSON.stringify(v)}`).join(', ') || 'no arguments';
}

export function confirmationBlocks(action: PendingAction, title: string): KnownBlock[] {
  return [
    { type: 'section', text: { type: 'mrkdwn', text: `:warning: *${title}* will change your org — ${describeArgs(action.args)}` } },
    {
      type: 'actions',
      block_id: `confirm_${action.id}`,
      elements: [
        {
          type: 'button',
          style: 'primary',
          text: { type: 'plain_text', text: 'Confirm' },
          action_id: 'auditdelta_confirm',
          value: action.id,
          confirm: {
            title: { type: 'plain_text', text: 'Change the org?' },
            text: { type: 'mrkdwn', text: `Run *${title}* now? This takes effect immediately in Salesforce.` },
            confirm: { type: 'plain_text', text: 'Run it' },
            deny: { type: 'plain_text', text: 'Back' },
          },
        },
        { type: 'button', text: { type: 'plain_text', text: 'Cancel' }, action_id: 'auditdelta_cancel', value: action.id },
      ],
    },
  ];
}

export interface AlertRef {
  orgId: string;
  component: string;
  category: string;
}
