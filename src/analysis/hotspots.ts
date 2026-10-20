/**
 * Change hotspots: which components get changed most, by how many people.
 * Classification works from Setup Audit Trail action/section/display strings.
 */

import { countSessions } from './bursts';
import { isAuditNoise } from './auditNoise';

export const HOTSPOT_CATEGORIES = ['Flow', 'Permission', 'User', 'Sharing', 'Object/Field', 'ValidationRule', 'Layout', 'Apex', 'Other'] as const;
export type HotspotCategory = (typeof HOTSPOT_CATEGORIES)[number];

export interface AuditEntry {
  action: string | null;
  section: string | null;
  display: string | null;
  createdByName: string | null;
  createdDate: Date | string;
}

export interface Hotspot {
  component: string;
  category: HotspotCategory;
  /** Change sessions (bursts by one editor collapsed), the ranking measure. */
  changes: number;
  /** Raw audit entries behind those sessions. */
  events: number;
  editors: number;
  topEditor: string;
  lastChange: string;
}

export interface HotspotResult {
  hotspots: Hotspot[];
  totalChanges: number;
  excludedNoise: number;
}

/** Order matters: validation rules and fields live under "Customize …" sections too. */
export function categorize(action: string, section: string): HotspotCategory {
  const a = action.toLowerCase();
  const s = section.toLowerCase();
  // Access grants inside permission sets ("…: X Apex class access was enabled") are permission changes,
  // even though the action names mention Apex or Flow.
  if (a.startsWith('setupentityaccessaudit')) return 'Permission';
  // Profile settings such as page layout assignments ("profilePageLayoutChanged…") are access changes.
  if (a.startsWith('profile')) return 'Permission';
  if (s.includes('sharing') || /^(int|ext)accesschanged|^owd/.test(a)) return 'Sharing';
  if (a.includes('flow') || a.includes('interactiondef') || s.includes('flow')) return 'Flow';
  if (a.includes('validation')) return 'ValidationRule';
  if (a.includes('layout') || a.includes('flexipage') || s.includes('layout') || s.includes('lightning page')) return 'Layout';
  if (a.includes('apex') || /class|trigger/.test(a) || s.startsWith('apex')) return 'Apex';
  if (s.includes('manage users') && !a.includes('perm') && !a.includes('profile') && !a.startsWith('role') && !a.includes('createdrole')) return 'User';
  if (a.includes('perm') || a.includes('profile') || a.includes('role') || s.includes('manage users') || s.includes('permission')) return 'Permission';
  if (a.includes('customfield') || /^(changed|created|deleted)cf/.test(a) || a.includes('entity') || a.includes('customobject') || s.startsWith('customize')) {
    return 'Object/Field';
  }
  return 'Other';
}

const unquote = (v: string) => v.trim().replace(/^["“']|["”']$/g, '').trim();

const COMPONENT_PATTERNS: Partial<Record<HotspotCategory, RegExp[]>> = {
  User: [/for user\s+(.+?)(?:\s+\(UserID|\s+from\s|,|\s*$)/i, /new user\s+(.+?)(?:\s+\(UserID|\s*$)/i, /to user\s+(.+?)(?:\s+\(UserID|\s*$)/i, /for\s+(005\w{12,15})\b/i],
  Sharing: [/access (?:update )?for\s+([\w.]+)\s+from/i, /sharing rule\s+["“]?(.+?)["”]?(?:\s+on|\s*$)/i],
  // Real format: 'Activated flow with Name "Flow Test" and Unique Name "Flow_Test"'.
  Flow: [/unique name\s+["“]([^"”]+)["”]/i, /flow with name\s+["“]([^"”]+)["”]/i, /of flow\s+(.+?)\s*$/i, /flow version\s+#?\d+\s+(.+?)\s*$/i, /flow\s+["“](.+?)["”]/i, /flow\s+([\w.-]+)/i],
  ValidationRule: [/validation rule\s+["“]?(.+?)["”]?\s+on\s+(?:object\s+)?([\w.]+)/i, /validation formula .*?["“](.+?)["”]/i],
  Permission: [
    /permission set group\s+["“]?([^:"”]+?)["”]?(?::|\s+to\s+|\s*$)/i,
    /permission set\s+["“]?([^:"”]+?)["”]?(?::|\s+to\s+|\s*$)/i,
    /profile\s+["“]?([^:"”]+?)["”]?(?::|\s+to\s+|\s*$)/i,
  ],
  'Object/Field': [/custom field:\s*(.+?)(?:\s*\([^)]*\))?\s*$/i, /custom field\s+(.+?)\s+on\s+(?:object\s+)?([\w.]+)/i, /field\s+(.+?)\s+on\s+([\w.]+)/i],
  Layout: [/lightning page:\s*(.+?)\s*$/i, /layout\s+["“]?(.+?)["”]?\s*$/i],
  // Real format: 'Changed B2BCartToOrderDraft Apex Class code'.
  // Visualforce pages: 'Changed Page RC_QuoteApproval'.
  Apex: [/^(?:changed|created|deleted)\s+([\w.]+)\s+apex\s+(?:class|trigger)/i, /^(?:changed|created|deleted)\s+page\s+([\w.]+)/i, /(?:class|trigger)(?:\s+code)?\s*:\s*([\w.]+)/i, /(?:class|trigger)\s+([\w.]+)/i],
};

export function componentOf(category: HotspotCategory, display: string, section: string, action: string): string {
  for (const pattern of COMPONENT_PATTERNS[category] ?? []) {
    const m = display.match(pattern);
    if (!m) continue;
    // Two captures = component on an object ("Account.Discount__c").
    return m[2] ? `${unquote(m[2])}.${unquote(m[1])}` : unquote(m[1]);
  }
  // Unparsed entries group by section so they don't fragment into one row per sentence.
  return section.replace(/^Customize\s+/i, '') || action || 'Unknown';
}

export function computeHotspots(entries: AuditEntry[], options: { category?: HotspotCategory; limit: number }): HotspotResult {
  const groups = new Map<string, { category: HotspotCategory; component: string; events: number; times: Map<string, number[]>; last: string }>();
  let excludedNoise = 0;

  for (const e of entries) {
    if (isAuditNoise(e)) {
      excludedNoise++;
      continue;
    }
    const action = e.action ?? '';
    const section = e.section ?? '';
    const category = categorize(action, section);
    if (options.category && category !== options.category) continue;
    const component = componentOf(category, e.display ?? '', section, action);
    const key = `${category}|${component.toLowerCase()}`;
    const group = groups.get(key) ?? { category, component, events: 0, times: new Map(), last: '' };
    group.events++;
    const editor = e.createdByName ?? 'Unknown';
    const when = new Date(e.createdDate);
    group.times.set(editor, [...(group.times.get(editor) ?? []), when.getTime()]);
    const date = when.toISOString();
    if (date > group.last) group.last = date;
    groups.set(key, group);
  }

  const all = [...groups.values()].map((g) => {
    const sessionsByEditor = [...g.times.entries()].map(([editor, times]) => [editor, countSessions(times)] as const);
    return {
      component: g.component,
      category: g.category,
      changes: sessionsByEditor.reduce((sum, [, n]) => sum + n, 0),
      events: g.events,
      editors: g.times.size,
      topEditor: [...sessionsByEditor].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'Unknown',
      lastChange: g.last,
    };
  });
  const totalChanges = all.reduce((sum, h) => sum + h.changes, 0);
  const hotspots = all.sort((a, b) => b.changes - a.changes || b.editors - a.editors || b.events - a.events).slice(0, options.limit);

  return { hotspots, totalChanges, excludedNoise };
}

export function hotspotsDisplayText(result: HotspotResult, days: number, category?: HotspotCategory): string {
  const scope = category ? `${category} changes` : 'changes';
  if (result.hotspots.length === 0) {
    return `No ${scope} in the last ${days} day(s)${result.excludedNoise ? ` (${result.excludedNoise} system entries ignored)` : ''}.`;
  }
  // Section-level "Other" buckets are real changes but too generic to headline.
  const top = result.hotspots.find((h) => h.category !== 'Other') ?? result.hotspots[0];
  const share = Math.round((top.changes / result.totalChanges) * 100);
  const lines = [
    `*Change hotspots — last ${days} day(s)* (${result.totalChanges} change sessions${result.excludedNoise ? `, ${result.excludedNoise} system entries ignored` : ''})`,
    `\`${top.component}\` (${top.category}) is the most-changed component: ${top.changes} change session(s) (${share}% of all) by ${top.editors} editor(s), mostly ${top.topEditor}.`,
    '',
    '*Top components* (change sessions · audit entries · editors · main editor · last change)',
    ...result.hotspots.map(
      (h, i) =>
        `${i + 1}. \`${h.component}\` [${h.category}]: ${h.changes} · ${h.events} · ${h.editors} · ${h.topEditor} · ${h.lastChange.slice(0, 10)}`
    ),
    '_A change session = one person editing a component; bulk saves that write many audit entries count once._',
  ];
  const fragile = result.hotspots.filter((h) => h.editors >= 3);
  if (fragile.length) {
    lines.push('', `Changed by 3+ people: ${fragile.map((h) => `\`${h.component}\``).join(', ')} — good candidates for an owner and a review rule.`);
  }
  return lines.join('\n');
}
