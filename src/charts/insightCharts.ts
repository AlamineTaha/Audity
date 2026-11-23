import type { EChartsOption, BarSeriesOption, ScatterSeriesOption } from 'echarts';
import { EARLIER_VERSIONS_ID, OwnershipResult } from '../analysis/flowOwnership';
import { HOTSPOT_CATEGORIES, HotspotResult } from '../analysis/hotspots';
import { ChartImage, FONT_FAMILY, PALETTE, baseOption, renderECharts, textWidth, truncateLabel } from './render';

const WIDTH = 1000;
const HEADER = 112;
const BAR = 20; // skill spec: bars <= 24px thick
const slug = (s: string) => s.replace(/[^a-z0-9]+/gi, '_').replace(/^_|_$/g, '').slice(0, 40) || 'chart';
const pct = (v: number) => `${Math.round(v * 100)}%`;

/** A small status pill in the top-right corner (e.g. the bus-factor warning). */
function badge(text: string, fg: string, bg: string): NonNullable<EChartsOption['graphic']> {
  const w = Math.round(textWidth(text, 12, 600) + 28);
  return [
    {
      type: 'group',
      right: 32,
      top: 30,
      children: [
        { type: 'rect', shape: { x: 0, y: 0, width: w, height: 26, r: 13 }, style: { fill: bg } },
        { type: 'circle', shape: { cx: 13, cy: 13, r: 3.5 }, style: { fill: fg } },
        { type: 'text', x: 22, y: 7, style: { text, fill: fg, font: `600 12px ${FONT_FAMILY}` } },
      ],
    },
  ];
}

/** Horizontal bars on a full-width track: share of the live version's logic per author. */
export function ownershipShareChart(flowName: string, result: OwnershipResult): Promise<ChartImage> {
  const owners = result.owners.filter((o) => o.liveShare > 0).sort((a, b) => b.liveShare - a.liveShare);
  const top = owners[0];
  const rows = owners.map((o) => ({
    name: o.authorId === EARLIER_VERSIONS_ID ? 'Earlier versions' : truncateLabel(o.name, 32),
    value: o.liveShare,
    color: o.authorId === EARLIER_VERSIONS_ID ? PALETTE.axis : o === top ? PALETTE.primary : PALETTE.muted,
  }));
  const height = HEADER + rows.length * 48 + 36;
  const labelW = Math.ceil(Math.max(...rows.map((r) => textWidth(r.name, 14, 500)))) + 28;
  const option: EChartsOption = {
    ...baseOption(`Who owns ${truncateLabel(flowName, 44)}`, `Share of the logic live in v${result.latestVersion}, credited to whoever last changed each part`),
    graphic: result.busFactorRisk && top ? badge(`Bus factor · ${pct(top.liveShare)} by one person`, PALETTE.status.critical, PALETTE.status.criticalSoft) : undefined,
    grid: { left: 37 + labelW, right: 92, top: HEADER, bottom: 24 },
    xAxis: { type: 'value', min: 0, max: 1, show: false },
    yAxis: {
      type: 'category',
      inverse: true,
      data: rows.map((r) => r.name),
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: { color: PALETTE.ink, fontSize: 14, fontWeight: 500, margin: labelW, align: 'left', fontFamily: FONT_FAMILY },
    },
    series: [
      {
        type: 'bar',
        barWidth: BAR,
        showBackground: true,
        backgroundStyle: { color: '#f2f4f7', borderRadius: 10 },
        data: rows.map((r) => ({ value: r.value, itemStyle: { color: r.color, borderRadius: 10 } })),
        label: {
          show: true,
          position: 'right',
          distance: 12,
          formatter: (p) => pct(Number(p.value)),
          color: PALETTE.ink,
          fontSize: 14,
          fontWeight: 600,
          fontFamily: FONT_FAMILY,
        },
      } as BarSeriesOption,
    ],
  };
  return Promise.resolve(renderECharts(option, WIDTH, height, `ownership_${slug(flowName)}.png`, `Live ownership of ${flowName}`));
}

/** Dot timeline: one row per author, one dot per version (size = fields changed); risky versions in red. */
export function ownershipTimelineChart(flowName: string, result: OwnershipResult): Promise<ChartImage> {
  const versions = [...new Set(result.timeline.map((t) => t.version))].sort((a, b) => a - b);
  const authors = [...new Set(result.timeline.map((t) => truncateLabel(t.author, 28)))];
  const maxFields = Math.max(1, ...result.timeline.map((t) => t.changedFields));
  const size = (fields: number) => Math.round(12 + 26 * Math.sqrt(fields / maxFields));
  const point = (t: OwnershipResult['timeline'][number]) => ({
    value: [`v${t.version}`, truncateLabel(t.author, 28), t.changedFields],
    risk: t.risk,
  });
  const safe = result.timeline.filter((t) => !t.risk).map(point);
  const risky = result.timeline.filter((t) => t.risk).map(point);
  const height = HEADER + 36 + authors.length * 70 + 56;

  const series = (name: string, data: ReturnType<typeof point>[], color: string, labelled: boolean): ScatterSeriesOption => ({
    name,
    type: 'scatter',
    data,
    symbolSize: (v: number[]) => size(Number(v[2])),
    itemStyle: { color, borderColor: '#ffffff', borderWidth: 2, opacity: 1 },
    z: labelled ? 3 : 2,
    label: labelled
      ? {
          show: true,
          position: 'top',
          distance: 10,
          formatter: (p) => String((p.data as { risk?: string }).risk ?? ''),
          color: PALETTE.status.critical,
          backgroundColor: PALETTE.status.criticalSoft,
          borderRadius: 9,
          padding: [3, 8],
          fontSize: 11,
          fontWeight: 700,
          fontFamily: FONT_FAMILY,
        }
      : { show: false },
  });

  const option: EChartsOption = {
    ...baseOption(`Version history of ${truncateLabel(flowName, 44)}`, 'Each dot is a saved version · dot size = number of fields changed'),
    legend: {
      top: 92,
      left: 30,
      icon: 'circle',
      itemWidth: 10,
      itemHeight: 10,
      itemGap: 22,
      textStyle: { color: PALETTE.inkSecondary, fontSize: 12, fontFamily: FONT_FAMILY },
      data: ['No new high risk', 'Introduced CRITICAL / HIGH risk'],
    },
    grid: { left: 32, right: 48, top: HEADER + 40, bottom: 44, containLabel: true },
    xAxis: {
      type: 'category',
      data: versions.map((v) => `v${v}`),
      boundaryGap: true,
      axisLine: { lineStyle: { color: PALETTE.axis } },
      axisTick: { show: false },
      axisLabel: { color: PALETTE.inkSecondary, fontSize: 13, fontWeight: 500, margin: 14, fontFamily: FONT_FAMILY },
      splitLine: { show: false },
    },
    yAxis: {
      type: 'category',
      data: authors,
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: { color: PALETTE.ink, fontSize: 14, fontWeight: 500, margin: 18, fontFamily: FONT_FAMILY },
      splitLine: { show: true, lineStyle: { color: PALETTE.grid, type: 'solid' } },
    },
    series: [series('No new high risk', safe, PALETTE.primary, false), series('Introduced CRITICAL / HIGH risk', risky, PALETTE.status.critical, true)],
  };
  return Promise.resolve(renderECharts(option, WIDTH, height, `ownership_timeline_${slug(flowName)}.png`, `Version history of ${flowName}`));
}

/** Horizontal bars of the most-changed components; hue = category (fixed slot per category). */
export function hotspotsChart(result: HotspotResult, days: number): Promise<ChartImage> {
  const rows = result.hotspots.map((h) => ({
    name: truncateLabel(h.component, 38),
    category: h.category,
    value: h.changes,
    label: `${h.changes} session${h.changes === 1 ? '' : 's'} · ${h.editors} editor${h.editors === 1 ? '' : 's'}`,
  }));
  const colorOf = (category: string) => {
    const i = HOTSPOT_CATEGORIES.indexOf(category as (typeof HOTSPOT_CATEGORIES)[number]);
    return category === 'Other' || i < 0 ? '#9aa6b5' : PALETTE.categorical[i % PALETTE.categorical.length];
  };
  const present = HOTSPOT_CATEGORIES.filter((c) => rows.some((r) => r.category === c));
  const categoryLabel: Record<string, string> = { ValidationRule: 'Validation rule', 'Object/Field': 'Object / field' };
  const labelW = Math.ceil(Math.max(...rows.map((r) => textWidth(r.name, 14, 500)))) + 30 + 24;
  const tipW = Math.ceil(Math.max(...rows.map((r) => textWidth(r.label, 13)))) + 24;
  const max = Math.max(1, ...rows.map((r) => r.value));
  const height = HEADER + (present.length > 1 ? 34 : 0) + rows.length * 44 + 32;

  const series: BarSeriesOption[] = present.map((category) => ({
    name: categoryLabel[category] ?? category,
    type: 'bar',
    stack: 'all',
    barWidth: BAR,
    itemStyle: { color: colorOf(category), borderRadius: [0, 6, 6, 0] },
    data: rows.map((r) => (r.category === category ? r.value : null)),
    label: {
      show: true,
      position: 'right',
      distance: 12,
      formatter: (p) => (p.value == null ? '' : rows[p.dataIndex].label),
      color: PALETTE.inkSecondary,
      fontSize: 13,
      fontFamily: FONT_FAMILY,
    },
  }));

  const option: EChartsOption = {
    ...baseOption(`Most-changed components · last ${days} days`, 'Change sessions: one person editing one component · bulk saves count once'),
    legend:
      present.length > 1
        ? { top: 92, left: 30, icon: 'roundRect', itemWidth: 12, itemHeight: 12, itemGap: 20, textStyle: { color: PALETTE.inkSecondary, fontSize: 12, fontFamily: FONT_FAMILY } }
        : undefined,
    grid: { left: 37 + labelW, right: 32 + tipW, top: HEADER + (present.length > 1 ? 34 : 0), bottom: 20 },
    xAxis: { type: 'value', min: 0, max, show: false },
    yAxis: {
      type: 'category',
      inverse: true,
      data: rows.map((r) => r.name),
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: {
        margin: labelW,
        align: 'left',
        fontFamily: FONT_FAMILY,
        formatter: (value: string, i: number) => `{rank|${i + 1}}{name|${value}}`,
        rich: {
          rank: { color: PALETTE.inkMuted, fontSize: 13, fontWeight: 600, fontFamily: FONT_FAMILY, width: 30 },
          name: { color: PALETTE.ink, fontSize: 14, fontWeight: 500, fontFamily: FONT_FAMILY },
        },
      },
    },
    series,
  };
  return Promise.resolve(renderECharts(option, WIDTH, height, `hotspots_${days}d.png`, `Change hotspots (${days} days)`));
}
