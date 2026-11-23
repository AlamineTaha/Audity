/**
 * Visual Flow diff: the new version's graph (ELK layered layout, top-down) drawn as hand-built SVG,
 * with added / changed / removed elements colored. Removed elements are placed by their old
 * connections when they still touch the graph, otherwise in a "Removed" lane under it.
 */

import { diffFlowVersions } from '../analysis/flowDiff';
import { ChartImage, FONT_FAMILY, PALETTE, escapeXml, svgToPng, textWidth } from './render';

// elkjs ships CommonJS without an ESM default; the bundled build runs in-process (no worker).
// eslint-disable-next-line @typescript-eslint/no-var-requires
const ELK = require('elkjs/lib/elk.bundled.js');

type Json = Record<string, unknown>;
type Change = 'added' | 'modified' | 'removed' | 'unchanged';
type EdgeKind = 'normal' | 'fault' | 'removed';

interface TypeStyle {
  label: string;
  color: string;
  icon: (x: number, y: number) => string;
}

const LOGIC = '#eb6834';
const DATA = '#d4508a';
const INTERACTION = PALETTE.primary;
const ACTION = '#6250d6';

// Small 14x14 glyphs drawn in white on the colored type tile; (x, y) is the glyph's top-left.
const g = (x: number, y: number, d: string, fill = false) =>
  `<path transform="translate(${x} ${y})" d="${d}" ${fill ? 'fill="#fff"' : 'fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"'}/>`;

const TYPES: Record<string, TypeStyle> = {
  start: { label: 'Start', color: PALETTE.ink, icon: (x, y) => g(x, y, 'M4 2.5v9l7.5-4.5z', true) },
  decisions: { label: 'Decision', color: LOGIC, icon: (x, y) => g(x, y, 'M7 1.5l5.5 5.5-5.5 5.5-5.5-5.5z') },
  assignments: { label: 'Assignment', color: LOGIC, icon: (x, y) => g(x, y, 'M2.5 5h9M2.5 9h9') },
  loops: { label: 'Loop', color: LOGIC, icon: (x, y) => g(x, y, 'M11.5 7a4.5 4.5 0 1 1-1.3-3.2M11 1.5v2.6H8.4') },
  collectionProcessors: { label: 'Collection', color: LOGIC, icon: (x, y) => g(x, y, 'M2 3.5h10M4 7h6M6 10.5h2') },
  waits: { label: 'Wait', color: LOGIC, icon: (x, y) => g(x, y, 'M7 1.8a5.2 5.2 0 1 0 0 10.4A5.2 5.2 0 0 0 7 1.8zM7 4.3V7l2 1.4') },
  recordLookups: { label: 'Get Records', color: DATA, icon: (x, y) => g(x, y, 'M6 2a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM9 9l3.2 3.2') },
  recordCreates: { label: 'Create Records', color: DATA, icon: (x, y) => g(x, y, 'M7 2.5v9M2.5 7h9') },
  recordUpdates: { label: 'Update Records', color: DATA, icon: (x, y) => g(x, y, 'M2.5 11.5l.6-2.7 6.4-6.4 2.1 2.1-6.4 6.4zM8.3 3.6l2.1 2.1') },
  recordDeletes: { label: 'Delete Records', color: DATA, icon: (x, y) => g(x, y, 'M3.5 3.5l7 7M10.5 3.5l-7 7') },
  recordRollbacks: { label: 'Roll Back', color: DATA, icon: (x, y) => g(x, y, 'M3 5h6a3 3 0 0 1 0 6H5M5.5 2.5L3 5l2.5 2.5') },
  actionCalls: { label: 'Action', color: ACTION, icon: (x, y) => g(x, y, 'M8 1.5L3 8h4l-1 4.5L11 6H7z', true) },
  apexPluginCalls: { label: 'Apex Action', color: ACTION, icon: (x, y) => g(x, y, 'M8 1.5L3 8h4l-1 4.5L11 6H7z', true) },
  subflows: { label: 'Subflow', color: ACTION, icon: (x, y) => g(x, y, 'M2 4.5h7v7H2zM5 4.5V2h7v7H9') },
  screens: { label: 'Screen', color: INTERACTION, icon: (x, y) => g(x, y, 'M1.8 2.5h10.4v7.5H1.8zM5 12.2h4') },
  steps: { label: 'Step', color: INTERACTION, icon: (x, y) => g(x, y, 'M2.5 3.5h9v7h-9z') },
  customErrors: { label: 'Custom Error', color: '#e34948', icon: (x, y) => g(x, y, 'M7 2.5v5.5M7 10.6v.4') },
  transforms: { label: 'Transform', color: ACTION, icon: (x, y) => g(x, y, 'M2 4.5h9l-2-2M12 9.5H3l2 2') },
  orchestratedStages: { label: 'Stage', color: ACTION, icon: (x, y) => g(x, y, 'M2.5 3.5h9v7h-9z') },
};

const CHANGE_STYLE: Record<Change, { fill: string; stroke: string; badge?: string; badgeFg?: string; badgeBg?: string }> = {
  unchanged: { fill: '#ffffff', stroke: '#d5dbe3' },
  added: { fill: PALETTE.status.goodSoft, stroke: PALETTE.status.good, badge: 'Added', badgeFg: '#ffffff', badgeBg: PALETTE.status.good },
  modified: { fill: PALETTE.status.warningSoft, stroke: PALETTE.status.warning, badge: 'Changed', badgeFg: '#ffffff', badgeBg: PALETTE.status.warning },
  removed: { fill: PALETTE.status.criticalSoft, stroke: PALETTE.status.critical, badge: 'Removed', badgeFg: PALETTE.status.critical, badgeBg: '#ffffff' },
};

const COMPACT_THRESHOLD = 60;
const PAD = 40;
const HEADER = 104;
const MIN_WIDTH = 820;

interface GNode {
  id: string;
  type: string;
  label: string;
  sub: string;
  change: Change;
}

interface GEdge {
  source: string;
  target: string;
  label?: string;
  kind: EdgeKind;
}

const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const target = (c: unknown): string | null => (isObj(c) && typeof c.targetReference === 'string' ? c.targetReference : null);

function startSubtitle(flow: Json): string {
  const start = isObj(flow.start) ? flow.start : {};
  const trigger: Record<string, string> = { Create: 'created', Update: 'updated', CreateAndUpdate: 'created or updated', Delete: 'deleted' };
  if (typeof start.object === 'string' && typeof start.recordTriggerType === 'string') {
    return `${start.object} ${trigger[start.recordTriggerType] ?? start.recordTriggerType}`;
  }
  if (start.triggerType === 'Scheduled') return 'Scheduled';
  if (start.triggerType === 'PlatformEvent') return `Event ${String(start.object ?? '')}`.trim();
  const processType = typeof flow.processType === 'string' ? flow.processType : '';
  return processType === 'Flow' ? 'Screen flow' : processType === 'AutoLaunchedFlow' ? 'Autolaunched' : processType;
}

/** Flow-node elements and their outgoing connectors (rule, loop, fault and scheduled paths included). */
function readFlow(flow: Json): { nodes: Map<string, Omit<GNode, 'change'>>; edges: GEdge[] } {
  const nodes = new Map<string, Omit<GNode, 'change'>>();
  const edges: GEdge[] = [];
  const add = (source: string, c: unknown, label?: string, kind: EdgeKind = 'normal') => {
    const t = target(c);
    if (t) edges.push({ source, target: t, label, kind });
  };

  if (isObj(flow.start)) {
    const start = flow.start;
    nodes.set('start', { id: 'start', type: 'start', label: 'Start', sub: startSubtitle(flow) });
    add('start', start.connector, Array.isArray(start.scheduledPaths) && start.scheduledPaths.length ? 'Run immediately' : undefined);
    for (const p of Array.isArray(start.scheduledPaths) ? start.scheduledPaths.filter(isObj) : []) {
      add('start', p.connector, String(p.label ?? p.name ?? 'Scheduled path'));
    }
  } else if (typeof flow.startElementReference === 'string') {
    nodes.set('start', { id: 'start', type: 'start', label: 'Start', sub: startSubtitle(flow) });
    edges.push({ source: 'start', target: flow.startElementReference, kind: 'normal' });
  }

  for (const type of Object.keys(TYPES)) {
    if (type === 'start' || !Array.isArray(flow[type])) continue;
    for (const el of (flow[type] as unknown[]).filter(isObj)) {
      if (typeof el.name !== 'string') continue;
      const id = el.name;
      nodes.set(id, { id, type, label: typeof el.label === 'string' && el.label ? el.label : id, sub: TYPES[type].label });
      for (const rule of Array.isArray(el.rules) ? el.rules.filter(isObj) : []) add(id, rule.connector, String(rule.label ?? rule.name ?? ''));
      for (const ev of Array.isArray(el.waitEvents) ? el.waitEvents.filter(isObj) : []) add(id, ev.connector, String(ev.label ?? ev.name ?? ''));
      add(id, el.nextValueConnector, 'For each item');
      add(id, el.noMoreValuesConnector, 'After last item');
      add(id, el.connector);
      add(id, el.defaultConnector, type === 'decisions' || type === 'waits' ? String(el.defaultConnectorLabel || 'Default') : undefined);
      add(id, el.faultConnector, 'Fault', 'fault');
    }
  }
  return { nodes, edges: edges.filter((e) => nodes.has(e.target)) };
}

const edgeKey = (e: GEdge) => `${e.source}>${e.target}>${e.kind === 'fault' ? 'f' : ''}${e.label ?? ''}`;

function fit(text: string, maxWidth: number, size: number, weight: number): string {
  if (textWidth(text, size, weight) <= maxWidth) return text;
  let s = text;
  while (s.length > 1 && textWidth(`${s}…`, size, weight) > maxWidth) s = s.slice(0, -1);
  return `${s}…`;
}

/** Orthogonal polyline with rounded corners. */
function roundedPath(points: Array<{ x: number; y: number }>, r = 10): string {
  let d = `M${points[0].x} ${points[0].y}`;
  for (let i = 1; i < points.length - 1; i++) {
    const [p, c, n] = [points[i - 1], points[i], points[i + 1]];
    const l1 = Math.hypot(c.x - p.x, c.y - p.y);
    const l2 = Math.hypot(n.x - c.x, n.y - c.y);
    const rr = Math.min(r, l1 / 2, l2 / 2);
    const a = { x: c.x - ((c.x - p.x) / (l1 || 1)) * rr, y: c.y - ((c.y - p.y) / (l1 || 1)) * rr };
    const b = { x: c.x + ((n.x - c.x) / (l2 || 1)) * rr, y: c.y + ((n.y - c.y) / (l2 || 1)) * rr };
    d += ` L${a.x} ${a.y} Q${c.x} ${c.y} ${b.x} ${b.y}`;
  }
  const last = points[points.length - 1];
  return `${d} L${last.x} ${last.y}`;
}

interface ElkLabel { text: string; width: number; height: number; x?: number; y?: number }
interface ElkEdge {
  id: string;
  sources: string[];
  targets: string[];
  labels?: ElkLabel[];
  sections?: Array<{ startPoint: { x: number; y: number }; endPoint: { x: number; y: number }; bendPoints?: Array<{ x: number; y: number }> }>;
}
interface ElkNode { id: string; width: number; height: number; x?: number; y?: number }
interface ElkGraph { id: string; children: ElkNode[]; edges: ElkEdge[]; width?: number; height?: number; layoutOptions: Record<string, string> }

export async function flowDiagramChart(
  flowName: string,
  oldMetadata: unknown,
  newMetadata: unknown,
  oldVersion?: number,
  newVersion?: number
): Promise<ChartImage> {
  const oldFlow = isObj(oldMetadata) ? oldMetadata : {};
  const newFlow = isObj(newMetadata) ? newMetadata : {};
  const diff = diffFlowVersions(oldFlow, newFlow, flowName, oldVersion, newVersion);
  const changeOf = new Map<string, Change>();
  for (const e of diff.elements) changeOf.set(e.type === 'start' ? 'start' : e.name, e.change);

  const before = readFlow(oldFlow);
  const after = readFlow(newFlow);
  const nodes = new Map<string, GNode>();
  for (const n of after.nodes.values()) {
    const c = changeOf.get(n.id);
    // An element present in both graphs whose diff says "added" (e.g. a legacy startElementReference
    // becoming a start element) changed shape rather than appearing.
    const existed = before.nodes.has(n.id);
    const change: Change = c === 'modified' || (c === 'added' && existed) ? 'modified' : c === 'added' || !before.nodes.size ? 'added' : 'unchanged';
    nodes.set(n.id, { ...n, change });
  }
  for (const n of before.nodes.values()) if (!nodes.has(n.id)) nodes.set(n.id, { ...n, change: 'removed' });

  // Old connectors that no longer exist: drawn faded, so removed elements sit where they used to.
  const liveKeys = new Set(after.edges.map(edgeKey));
  const removedEdges = before.edges.filter((e) => !liveKeys.has(edgeKey(e)) && nodes.has(e.source) && nodes.has(e.target)).map((e) => ({ ...e, kind: 'removed' as const }));
  const edges = [...after.edges, ...removedEdges];

  // Removed elements with no tie to anything still drawn go to the lane under the graph.
  const touches = new Map<string, number>();
  for (const e of edges) {
    if (nodes.get(e.source)?.change !== 'removed' || nodes.get(e.target)?.change !== 'removed') {
      touches.set(e.source, (touches.get(e.source) ?? 0) + 1);
      touches.set(e.target, (touches.get(e.target) ?? 0) + 1);
    }
  }
  const laned = [...nodes.values()].filter((n) => n.change === 'removed' && !touches.has(n.id));
  const lanedIds = new Set(laned.map((n) => n.id));
  const graphNodes = [...nodes.values()].filter((n) => !lanedIds.has(n.id));
  const graphEdges = edges.filter((e) => !lanedIds.has(e.source) && !lanedIds.has(e.target));

  const compact = nodes.size > COMPACT_THRESHOLD;
  const NW = compact ? 176 : 236;
  const NH = compact ? 40 : 60;
  const labelSize = compact ? 10 : 11;

  const elk = new ELK();
  const graph: ElkGraph = {
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'DOWN',
      'elk.edgeRouting': 'ORTHOGONAL',
      'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
      'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
      'elk.layered.spacing.nodeNodeBetweenLayers': compact ? '38' : '56',
      'elk.spacing.nodeNode': compact ? '22' : '40',
      'elk.layered.spacing.edgeNodeBetweenLayers': compact ? '16' : '24',
      'elk.spacing.edgeNode': '20',
      'elk.spacing.edgeEdge': '14',
      'elk.spacing.edgeLabel': '4',
      'elk.spacing.componentComponent': '48',
      'elk.edgeLabels.inline': 'false',
      'elk.layered.edgeLabels.sideSelection': 'ALWAYS_DOWN',
      'elk.layered.mergeEdges': 'false',
      'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
      // Big flows: fold the long top-down chain into side-by-side columns instead of a 7000px strip.
      ...(compact ? { 'elk.layered.wrapping.strategy': 'MULTI_EDGE', 'elk.aspectRatio': '1.3', 'elk.layered.wrapping.additionalEdgeSpacing': '10' } : {}),
    },
    children: graphNodes.map((n) => ({ id: n.id, width: NW, height: NH })),
    edges: graphEdges.map((e, i) => ({
      id: `e${i}`,
      sources: [e.source],
      targets: [e.target],
      // Compact mode wraps the layout, and ELK mis-routes wrapped edges that carry labels; those
      // labels are placed by hand on the edge instead.
      labels: e.label && !compact ? [{ text: fit(e.label, 150, labelSize, 500), width: Math.ceil(textWidth(fit(e.label, 150, labelSize, 500), labelSize, 500)) + 16, height: compact ? 18 : 20 }] : [],
    })),
  };
  let laid: ElkGraph;
  try {
    laid = await elk.layout(graph);
  } catch {
    // Wrapping is the less battle-tested ELK path; fall back to a plain (taller) layout.
    const plain = Object.fromEntries(Object.entries(graph.layoutOptions).filter(([k]) => !k.startsWith('elk.layered.wrapping') && k !== 'elk.aspectRatio'));
    laid = await elk.layout({ ...graph, layoutOptions: plain });
  }

  const graphW = laid.width ?? 0;
  const graphH = laid.height ?? 0;
  const laneCols = Math.max(1, Math.floor((Math.max(graphW, MIN_WIDTH - 2 * PAD) + 24) / (NW + 24)));
  const laneRows = Math.ceil(laned.length / laneCols);
  const laneH = laned.length ? 44 + laneRows * (NH + 20) : 0;
  const LEGEND_H = 64;
  const width = Math.ceil(Math.max(MIN_WIDTH, graphW + 2 * PAD));
  const height = Math.ceil(HEADER + graphH + laneH + LEGEND_H + 24);
  const ox = Math.round((width - graphW) / 2);
  const oy = HEADER;

  const svg: string[] = [];
  svg.push(`<defs>
    <marker id="arrow" viewBox="0 0 10 10" refX="8.5" refY="5" markerUnits="userSpaceOnUse" markerWidth="11" markerHeight="11" orient="auto-start-reverse"><path d="M1 1.5L8.5 5 1 8.5z" fill="#8a97a8"/></marker>
    <marker id="arrowFault" viewBox="0 0 10 10" refX="8.5" refY="5" markerUnits="userSpaceOnUse" markerWidth="11" markerHeight="11" orient="auto-start-reverse"><path d="M1 1.5L8.5 5 1 8.5z" fill="${PALETTE.status.serious}"/></marker>
    <marker id="arrowRemoved" viewBox="0 0 10 10" refX="8.5" refY="5" markerUnits="userSpaceOnUse" markerWidth="11" markerHeight="11" orient="auto-start-reverse"><path d="M1 1.5L8.5 5 1 8.5z" fill="#e7a3a3"/></marker>
    <filter id="shadow" x="-10%" y="-20%" width="120%" height="150%"><feDropShadow dx="0" dy="1" stdDeviation="1.5" flood-color="#0b1f33" flood-opacity="0.08"/></filter>
  </defs>`);

  // Header
  const counts = { added: 0, modified: 0, removed: 0 };
  for (const n of nodes.values()) if (n.change !== 'unchanged') counts[n.change]++;
  const versions = oldVersion != null && newVersion != null ? `v${oldVersion} → v${newVersion}` : 'Previous → latest version';
  const summary = [
    counts.added && `${counts.added} added`,
    counts.modified && `${counts.modified} changed`,
    counts.removed && `${counts.removed} removed`,
  ].filter(Boolean).join(' · ') || 'No element changes';
  svg.push(`<text x="${PAD}" y="52" font-family="${FONT_FAMILY}" font-size="19" font-weight="600" fill="${PALETTE.ink}">${escapeXml(fit(flowName, width - 2 * PAD - 120, 19, 600))}</text>`);
  svg.push(`<text x="${PAD}" y="78" font-family="${FONT_FAMILY}" font-size="13" fill="${PALETTE.inkSecondary}">${escapeXml(`${versions} · ${nodes.size} elements · ${summary}`)}</text>`);

  // Edges first, so nodes sit on top of line ends.
  const labelSvg: string[] = [];
  (laid.edges ?? []).forEach((le, i) => {
    const e = graphEdges[i];
    // Wrapped layouts (compact mode) split an edge into several chained sections.
    const sections = le.sections ?? [];
    if (!sections.length) return;
    const pts = sections.flatMap((sec) => [sec.startPoint, ...(sec.bendPoints ?? []), sec.endPoint]).map((p) => ({ x: p.x + ox, y: p.y + oy }));
    const style =
      e.kind === 'fault'
        ? `stroke="${PALETTE.status.serious}" stroke-dasharray="5 4" marker-end="url(#arrowFault)"`
        : e.kind === 'removed'
          ? `stroke="#e7a3a3" stroke-dasharray="5 4" marker-end="url(#arrowRemoved)"`
          : `stroke="#a7b3c2" marker-end="url(#arrow)"`;
    svg.push(`<path d="${roundedPath(pts)}" fill="none" stroke-width="1.6" ${style}/>`);
    const placed: ElkLabel[] = [...(le.labels ?? [])];
    if (compact && e.label && e.kind !== 'fault') {
      // Middle of the longest vertical run, just right of the line.
      let best = { len: -1, x: 0, y: 0 };
      for (let k = 1; k < pts.length; k++) {
        const len = Math.abs(pts[k].y - pts[k - 1].y);
        if (pts[k].x === pts[k - 1].x && len > best.len) best = { len, x: pts[k].x, y: (pts[k].y + pts[k - 1].y) / 2 };
      }
      const text = fit(e.label, 110, labelSize, 500);
      const w = Math.ceil(textWidth(text, labelSize, 500)) + 12;
      if (best.len >= 0) placed.push({ text, width: w, height: 16, x: best.x + 5 - ox, y: best.y - 8 - oy });
    }
    for (const l of placed) {
      if (l.x == null || l.y == null) continue;
      const [x, y] = [l.x + ox, l.y + oy];
      const fg = e.kind === 'fault' ? PALETTE.status.serious : e.kind === 'removed' ? PALETTE.status.critical : PALETTE.inkSecondary;
      const border = e.kind === 'fault' ? '#f5c6ad' : e.kind === 'removed' ? '#f1c4c4' : '#dfe4ea';
      labelSvg.push(
        `<g opacity="${e.kind === 'removed' ? 0.8 : 1}"><rect x="${x}" y="${y}" width="${l.width}" height="${l.height}" rx="${l.height / 2}" fill="#ffffff" stroke="${border}"/>` +
          `<text x="${x + l.width / 2}" y="${y + l.height / 2 + labelSize * 0.36}" text-anchor="middle" font-family="${FONT_FAMILY}" font-size="${labelSize}" font-weight="500" fill="${fg}">${escapeXml(l.text)}</text></g>`
      );
    }
  });

  const drawNode = (n: GNode, x: number, y: number) => {
    const st = CHANGE_STYLE[n.change];
    const type = TYPES[n.type] ?? TYPES.actionCalls;
    const removed = n.change === 'removed';
    const tile = compact ? 22 : 30;
    const tx = x + (compact ? 9 : 14);
    const ty = y + (NH - tile) / 2;
    const textX = tx + tile + (compact ? 9 : 12);
    const badgeW = st.badge ? Math.ceil(textWidth(st.badge, 10, 600)) + 14 : 0;
    const textMax = x + NW - textX - (compact ? 10 : 12);
    const out: string[] = [`<g opacity="${removed ? 0.78 : 1}">`];
    out.push(
      `<rect x="${x}" y="${y}" width="${NW}" height="${NH}" rx="${compact ? 9 : 12}" fill="${st.fill}" stroke="${st.stroke}" stroke-width="${n.change === 'unchanged' ? 1 : 1.6}"${removed ? ' stroke-dasharray="5 4"' : ''}${removed ? '' : ' filter="url(#shadow)"'}/>`
    );
    out.push(`<rect x="${tx}" y="${ty}" width="${tile}" height="${tile}" rx="${compact ? 6 : 8}" fill="${removed ? '#e7a3a3' : type.color}"/>`);
    const s = tile / 14 * 0.78;
    out.push(`<g transform="translate(${tx + tile / 2} ${ty + tile / 2}) scale(${s}) translate(-7 -7)">${type.icon(0, 0)}</g>`);
    const labelColor = removed ? PALETTE.status.critical : PALETTE.ink;
    if (compact) {
      out.push(`<text x="${textX}" y="${y + NH / 2 + 4}" font-family="${FONT_FAMILY}" font-size="12" font-weight="600" fill="${labelColor}">${escapeXml(fit(n.label, textMax, 12, 600))}</text>`);
    } else {
      out.push(`<text x="${textX}" y="${y + 26}" font-family="${FONT_FAMILY}" font-size="13.5" font-weight="600" fill="${labelColor}"${removed ? ' text-decoration="line-through"' : ''}>${escapeXml(fit(n.label, textMax, 13.5, 600))}</text>`);
      out.push(`<text x="${textX}" y="${y + 44}" font-family="${FONT_FAMILY}" font-size="11.5" fill="${PALETTE.inkSecondary}">${escapeXml(fit(n.sub, textMax, 11.5, 400))}</text>`);
    }
    if (st.badge) {
      // Full view: pill in the bottom-right; compact view: a small dot in the top-right corner.
      if (compact) {
        out.push(`<circle cx="${x + NW - 8}" cy="${y + 8}" r="4" fill="${st.stroke}" stroke="#fff" stroke-width="1.5"/>`);
      } else {
        const bx = x + NW - badgeW - 10;
        const by = y - 8.5;
        out.push(`<rect x="${bx}" y="${by}" width="${badgeW}" height="17" rx="8.5" fill="${st.badgeBg}" stroke="${st.stroke}" stroke-width="${removed ? 1 : 0}"/>`);
        out.push(`<text x="${bx + badgeW / 2}" y="${by + 12}" text-anchor="middle" font-family="${FONT_FAMILY}" font-size="10" font-weight="600" fill="${st.badgeFg}">${st.badge}</text>`);
      }
    }
    out.push('</g>');
    return out.join('');
  };

  const pos = new Map((laid.children ?? []).map((c) => [c.id, c]));
  for (const n of graphNodes) {
    const p = pos.get(n.id);
    if (p?.x != null && p.y != null) svg.push(drawNode(n, p.x + ox, p.y + oy));
  }
  svg.push(...labelSvg);

  // Removed lane
  let y = HEADER + graphH;
  if (laned.length) {
    y += 20;
    const laneW = laneCols * (NW + 24) - 24;
    const lx = Math.round((width - Math.min(laneW, laned.length * (NW + 24) - 24)) / 2);
    svg.push(`<line x1="${PAD}" y1="${y}" x2="${width - PAD}" y2="${y}" stroke="${PALETTE.grid}"/>`);
    svg.push(`<text x="${PAD}" y="${y + 26}" font-family="${FONT_FAMILY}" font-size="12" font-weight="600" fill="${PALETTE.inkSecondary}">Removed · no longer connected</text>`);
    laned.forEach((n, i) => svg.push(drawNode(n, lx + (i % laneCols) * (NW + 24), y + 40 + Math.floor(i / laneCols) * (NH + 20))));
    y += laneH - 20;
  }

  // Legend
  const ly = y + 34;
  const items: Array<{ text: string; draw: (x: number) => string; w: number }> = [
    ...(['added', 'modified', 'unchanged', 'removed'] as Change[]).map((c) => {
      const st = CHANGE_STYLE[c];
      const text = { added: 'Added', modified: 'Changed', unchanged: 'Unchanged', removed: 'Removed' }[c];
      return {
        text,
        w: 22 + textWidth(text, 12),
        draw: (x: number) =>
          `<rect x="${x}" y="${ly - 10}" width="14" height="14" rx="4" fill="${st.fill}" stroke="${st.stroke}" stroke-width="1.4"${c === 'removed' ? ' stroke-dasharray="3 2"' : ''}/>`,
      };
    }),
    { text: 'Fault path', w: 34 + textWidth('Fault path', 12), draw: (x: number) => `<line x1="${x}" y1="${ly - 3}" x2="${x + 24}" y2="${ly - 3}" stroke="${PALETTE.status.serious}" stroke-width="1.6" stroke-dasharray="5 4"/>` },
    { text: 'Removed connector', w: 34 + textWidth('Removed connector', 12), draw: (x: number) => `<line x1="${x}" y1="${ly - 3}" x2="${x + 24}" y2="${ly - 3}" stroke="#e7a3a3" stroke-width="1.6" stroke-dasharray="5 4"/>` },
  ];
  svg.push(`<line x1="${PAD}" y1="${ly - 30}" x2="${width - PAD}" y2="${ly - 30}" stroke="${PALETTE.grid}"/>`);
  let lx = PAD;
  for (const it of items) {
    const markW = it.w - textWidth(it.text, 12);
    svg.push(it.draw(lx));
    svg.push(`<text x="${lx + markW}" y="${ly + 1.5}" font-family="${FONT_FAMILY}" font-size="12" fill="${PALETTE.inkSecondary}">${it.text}</text>`);
    lx += it.w + 22;
  }

  // Keep very large flows within Slack's comfortable image size.
  const scale = Math.max(1, Math.min(2, 6000 / Math.max(width, height)));
  const inner = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${svg.join('\n')}</svg>`;
  const slug = flowName.replace(/[^a-z0-9]+/gi, '_').slice(0, 40) || 'flow';
  return {
    filename: `flow_diagram_${slug}_v${oldVersion ?? 'old'}_v${newVersion ?? 'new'}.png`,
    title: `${flowName} ${versions}`,
    png: svgToPng(inner, width, height, scale),
  };
}

/** For tool results: a diagram that fails to render must not lose the text answer. */
export async function flowDiagramImages(...args: Parameters<typeof flowDiagramChart>): Promise<ChartImage[]> {
  try {
    return [await flowDiagramChart(...args)];
  } catch (error) {
    console.error('[FlowDiagram] Rendering failed:', error);
    return [];
  }
}
