/**
 * AuditDelta Slack design system: every alert renders as a big header, a colored severity
 * border (message attachment), a facts grid, the summary, actions and a quiet footer.
 */

import type { KnownBlock } from '@slack/types';

export type Severity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'OK' | 'INFO';

export const SEVERITY_STYLE: Record<Severity, { color: string; pill: string }> = {
  CRITICAL: { color: '#E01E5A', pill: ':red_circle: *Critical*' },
  HIGH: { color: '#F2994A', pill: ':large_orange_circle: *High*' },
  MEDIUM: { color: '#ECB22E', pill: ':large_yellow_circle: *Medium*' },
  LOW: { color: '#2EB67D', pill: ':large_green_circle: *Low*' },
  OK: { color: '#2EB67D', pill: ':large_green_circle: *No new risk*' },
  INFO: { color: '#1D9BD1', pill: ':large_blue_circle: *Info*' },
};

/** A Slack message with a colored left border: blocks above, attachment blocks inside the border. */
export interface StyledMessage {
  text: string;
  blocks: KnownBlock[];
  attachments: Array<{ color: string; blocks: KnownBlock[]; fallback?: string }>;
}

const SECTION_LIMIT = 2900;

export function mrkdwn(text: string): KnownBlock[] {
  const blocks: KnownBlock[] = [];
  for (let i = 0; i < text.length && blocks.length < 8; i += SECTION_LIMIT) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: text.slice(i, i + SECTION_LIMIT) } });
  }
  return blocks;
}

export function header(text: string): KnownBlock {
  return { type: 'header', text: { type: 'plain_text', text: text.length > 148 ? `${text.slice(0, 147)}…` : text, emoji: true } };
}

export function context(...parts: Array<string | null | undefined>): KnownBlock {
  return { type: 'context', elements: [{ type: 'mrkdwn', text: parts.filter(Boolean).join('  ·  ') }] };
}

export function facts(pairs: Array<[string, string | null | undefined]>): KnownBlock | null {
  const fields = pairs
    .filter(([, value]) => value)
    .slice(0, 10)
    .map(([label, value]) => ({ type: 'mrkdwn' as const, text: `*${label}*\n${value}` }));
  return fields.length ? { type: 'section', fields } : null;
}

// ---------------- Alerts ----------------

const KIND_TITLES: Record<string, string> = {
  FLOW: 'Flow changed',
  'VALIDATION RULE': 'Validation rule changed',
  'FORMULA FIELD': 'Formula field changed',
  'CUSTOM FIELD': 'Field changed',
  'CUSTOM FIELD CHANGE': 'Field changed',
  PERMISSION: 'Permission changes',
  SECURITY: 'Security',
  OBJECT: 'Object changed',
  'PAGE LAYOUT': 'Page layout changed',
  METADATA: 'Setup change',
};

const KIND_ICONS: Record<string, string> = {
  FLOW: ':twisted_rightwards_arrows:',
  'VALIDATION RULE': ':shield:',
  'FORMULA FIELD': ':abacus:',
  'CUSTOM FIELD': ':label:',
  'CUSTOM FIELD CHANGE': ':label:',
  PERMISSION: ':key:',
  SECURITY: ':rotating_light:',
};

export interface ParsedAlert {
  kind: string;
  title: string;
  subtitle?: string;
  severity: Severity;
  changedBy?: string;
  when?: string;
  link?: string;
  body: string;
}

function severityFrom(text: string | undefined): Severity | null {
  if (!text) return null;
  const t = text.toUpperCase();
  if (t.includes('NONE')) return 'OK';
  for (const s of ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] as const) if (t.includes(s)) return s;
  return null;
}

/**
 * Monitor builders emit "*[KIND] Name* · subtitle", optional "*Risk…:* X" lines, the analysis,
 * then "*Changed by:* / *Time:* / *View in Salesforce:*". Parsed here once for every alert type.
 */
export function parseAlertText(text: string): ParsedAlert {
  const lines = text.split('\n');
  let kind = 'METADATA';
  let title = '';
  let subtitle: string | undefined;
  const first = lines[0]?.trim() ?? '';
  const m = first.match(/^\*\[([^\]]+)\]\s*([^*]*)\*\s*(.*)$/);
  if (m) {
    // Older fallbacks put the name inside the brackets: "[Formula Field: AD Test Priority]".
    const [rawKind, nameInKind] = m[1].split(/:\s*/, 2);
    kind = rawKind.trim().toUpperCase();
    title = m[2].trim() || nameInKind?.trim() || '';
    subtitle = m[3].replace(/^·\s*/, '').trim() || undefined;
    lines.shift();
  }

  let severity: Severity | null = null;
  let changedBy: string | undefined;
  let when: string | undefined;
  let link: string | undefined;
  const body: string[] = [];
  for (const line of lines) {
    const risk = line.match(/^\*Risk(?: introduced)?:\*\s*(.+)$/i);
    const by = line.match(/^\*Changed by:\*\s*(.+)$/i);
    const time = line.match(/^\*Time:\*\s*(.+)$/i);
    const view = line.match(/^\*View in Salesforce:\*\s*(\S+)/i);
    if (risk) severity = severityFrom(risk[1]) ?? severity;
    else if (by) {
      const [who, at] = by[1].split(/\s+·\s+/);
      changedBy = who;
      when = when ?? at;
    } else if (time) when = time[1];
    else if (view) link = view[1].replace(/^<|>$/g, '').split('|')[0];
    else body.push(line);
  }

  if (!severity) {
    // Alerts without an explicit risk line: take the worst "[SEVERITY]" mentioned in the analysis.
    severity = severityFrom(body.join(' ').match(/\[(CRITICAL|HIGH|MEDIUM|LOW)\]/i)?.[1]) ?? (kind === 'SECURITY' ? 'HIGH' : 'INFO');
  }
  return { kind, title, subtitle, severity, changedBy, when, link, body: body.join('\n').trim() };
}


export function alertMessage(text: string, ref: { orgId: string; category: string; value: string }): StyledMessage {
  const a = parseAlertText(text);
  const kindTitle = KIND_TITLES[a.kind] ?? a.kind.charAt(0) + a.kind.slice(1).toLowerCase();
  const headline = a.kind === 'SECURITY' ? a.title || kindTitle : a.title ? `${kindTitle} · ${a.title}` : kindTitle;
  const style = SEVERITY_STYLE[a.severity];

  const inner: KnownBlock[] = [context(style.pill, `${KIND_ICONS[a.kind] ?? ':gear:'} ${kindTitle}`, a.subtitle)];
  const grid = facts([
    ['Changed by', a.changedBy],
    ['When', a.when],
  ]);
  if (grid) inner.push(grid);
  if (a.body) inner.push(...mrkdwn(a.body));
  inner.push({
    type: 'actions',
    block_id: 'alert_actions',
    elements: [
      { type: 'button', style: 'primary', text: { type: 'plain_text', text: 'Explain impact' }, action_id: 'auditdelta_explain', value: ref.value },
      { type: 'button', text: { type: 'plain_text', text: 'Acknowledge' }, action_id: 'auditdelta_ack', value: ref.value },
      ...(a.link ? [{ type: 'button' as const, text: { type: 'plain_text' as const, text: 'View in Salesforce' }, url: a.link, action_id: 'auditdelta_view' }] : []),
    ],
  });
  inner.push(context(`AuditDelta`, ref.category, `org \`${ref.orgId}\``));

  return {
    text: `${headline} — ${a.severity === 'INFO' ? 'setup change' : `${a.severity.toLowerCase()} risk`}`,
    blocks: [header(`${a.severity === 'CRITICAL' ? '🔴 ' : a.severity === 'HIGH' ? '🟠 ' : ''}${headline}`)],
    attachments: [{ color: style.color, blocks: inner, fallback: headline }],
  };
}
