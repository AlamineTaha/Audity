import { EARLIER_VERSIONS_ID, OwnershipResult } from '../analysis/flowOwnership';
import { HOTSPOT_CATEGORIES, HotspotResult } from '../analysis/hotspots';
import { ChartImage, PALETTE, renderVegaLite, truncateLabel } from './render';

const BAR_SIZE = 20; // skill spec: <= 24px thick
const ROW_HEIGHT = 34;
const slug = (s: string) => s.replace(/[^a-z0-9]+/gi, '_').replace(/^_|_$/g, '').slice(0, 40) || 'chart';

function barAxisY() {
  return { title: null, axis: { labelLimit: 320, domain: false, ticks: false, labelPadding: 8, grid: false } };
}

// Every bar carries its value at the tip, so the value axis and grid would only add ink.
const HIDDEN_VALUE_AXIS = null;

/** Horizontal bars: share of the live version's logic per author (single series, no legend). */
export function ownershipShareChart(flowName: string, result: OwnershipResult): Promise<ChartImage> {
  const values = result.owners
    .filter((o) => o.liveShare > 0)
    .map((o) => ({ name: truncateLabel(o.name, 36), share: o.liveShare, earlier: o.authorId === EARLIER_VERSIONS_ID }));
  // Explicit order: '-x' sorting conflicts across layers.
  const y = { field: 'name', type: 'nominal', sort: values.map((v) => v.name), ...barAxisY() };
  return renderVegaLite(
    {
      title: { text: `Who wrote the live logic of ${truncateLabel(flowName, 48)}`, subtitle: `Share of the fields in v${result.latestVersion}, by the person who last changed each field` },
      width: 520,
      height: Math.max(ROW_HEIGHT * values.length, ROW_HEIGHT * 2),
      data: { values },
      layer: [
        {
          mark: { type: 'bar', cornerRadiusEnd: 4, size: BAR_SIZE },
          encoding: {
            y,
            x: { field: 'share', type: 'quantitative', scale: { domain: [0, 1.12] }, axis: HIDDEN_VALUE_AXIS },
            // "Earlier versions" is not a person, so it recedes to the muted step.
            color: { condition: { test: 'datum.earlier', value: PALETTE.axis }, value: PALETTE.categorical[0] },
          },
        },
        {
          mark: { type: 'text', align: 'left', dx: 6, color: PALETTE.inkPrimary, fontWeight: 600 },
          encoding: { y, x: { field: 'share', type: 'quantitative' }, text: { field: 'share', format: '.0%' } },
        },
      ],
    },
    `ownership_${slug(flowName)}.png`,
    `Live ownership of ${flowName}`
  );
}

/** Dot strip: one row per author, one dot per version sized by changed fields; risk in status red. */
export function ownershipTimelineChart(flowName: string, result: OwnershipResult): Promise<ChartImage> {
  const SAFE = 'No new high risk';
  const RISKY = 'Introduced CRITICAL/HIGH risk';
  const values = result.timeline.map((t) => ({
    version: `v${t.version}`,
    order: t.version,
    author: truncateLabel(t.author, 30),
    changedFields: t.changedFields,
    riskClass: t.risk ? RISKY : SAFE,
    risk: t.risk ?? '',
  }));
  const authors = new Set(values.map((v) => v.author)).size;
  const x = { field: 'version', type: 'ordinal', sort: { field: 'order' }, title: 'Version', axis: { labelAngle: 0, grid: false, domain: true, ticks: false } };
  const y = { field: 'author', type: 'nominal', title: null, axis: { grid: true, domain: false, ticks: false, labelLimit: 200, labelPadding: 8 } };
  return renderVegaLite(
    {
      title: { text: `Version history of ${truncateLabel(flowName, 48)}`, subtitle: 'Each dot is a version; size = fields changed' },
      width: Math.min(720, Math.max(360, values.length * 34)),
      height: Math.max(56 * authors, 112),
      data: { values },
      layer: [
        {
          mark: { type: 'point', filled: true, opacity: 1, stroke: PALETTE.surface, strokeWidth: 2 },
          encoding: {
            x,
            y,
            size: { field: 'changedFields', type: 'quantitative', title: 'Fields changed', scale: { range: [80, 700] }, legend: { symbolFillColor: PALETTE.inkMuted, symbolStrokeWidth: 0 } },
            color: { field: 'riskClass', type: 'nominal', title: null, scale: { domain: [SAFE, RISKY], range: [PALETTE.categorical[0], PALETTE.critical] }, legend: { labelLimit: 260 } },
          },
        },
        {
          transform: [{ filter: "datum.risk !== ''" }],
          mark: { type: 'text', dy: -18, fontSize: 10, fontWeight: 700, color: PALETTE.inkPrimary },
          encoding: { x, y, text: { field: 'risk' } },
        },
      ],
    },
    `ownership_timeline_${slug(flowName)}.png`,
    `Version history of ${flowName}`
  );
}

/** Horizontal bars of most-changed components, color = category (fixed slot per category). */
export function hotspotsChart(result: HotspotResult, days: number): Promise<ChartImage> {
  const values = result.hotspots.map((h) => ({
    component: truncateLabel(h.component, 40),
    category: h.category,
    changes: h.changes,
    label: `${h.changes} session${h.changes === 1 ? '' : 's'} · ${h.editors} editor${h.editors === 1 ? '' : 's'}`,
  }));
  const y = { field: 'component', type: 'nominal', sort: values.map((v) => v.component), ...barAxisY() };
  const maxChanges = Math.max(...values.map((v) => v.changes), 1);
  return renderVegaLite(
    {
      title: { text: `Most-changed components — last ${days} days`, subtitle: 'Change sessions (one person editing a component; bulk saves count once) · distinct editors' },
      width: 520,
      height: Math.max(ROW_HEIGHT * values.length, ROW_HEIGHT * 2),
      data: { values },
      layer: [
        {
          mark: { type: 'bar', cornerRadiusEnd: 4, size: BAR_SIZE },
          encoding: {
            y,
            // Headroom so the tip labels never clip at the right edge.
            x: { field: 'changes', type: 'quantitative', title: null, scale: { domain: [0, Math.ceil(maxChanges * 1.3)] }, axis: HIDDEN_VALUE_AXIS },
            color: {
              field: 'category',
              type: 'nominal',
              title: null,
              // Fixed hue per category across charts; "Other" stays neutral so it never competes.
              scale: {
                domain: [...HOTSPOT_CATEGORIES],
                range: HOTSPOT_CATEGORIES.map((c, i) => (c === 'Other' ? '#9a9a96' : PALETTE.categorical[i])),
              },
              legend: { values: [...new Set(values.map((v) => v.category))] },
            },
          },
        },
        {
          mark: { type: 'text', align: 'left', dx: 6, color: PALETTE.inkSecondary },
          encoding: { y, x: { field: 'changes', type: 'quantitative' }, text: { field: 'label' } },
        },
      ],
    },
    `hotspots_${days}d.png`,
    `Change hotspots (${days} days)`
  );
}
