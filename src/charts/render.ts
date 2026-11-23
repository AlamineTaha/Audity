/**
 * Server-side rendering: Apache ECharts (SSR, SVG) or hand-built SVG -> PNG via resvg, with the
 * bundled Inter font so output is identical on macOS, Docker and Heroku. No external service,
 * so org data never leaves the server.
 */

import path from 'path';
import fs from 'fs';
import * as echarts from 'echarts';
import { Resvg } from '@resvg/resvg-js';

/**
 * Design tokens. Ink is navy/slate; categorical hues are the validated reference palette
 * (dataviz skill, light mode) in fixed order; status hues are reserved for risk.
 */
export const PALETTE = {
  surface: '#ffffff',
  cardBorder: '#e4e8ee',
  ink: '#0b1f33',
  inkSecondary: '#5b6b7f',
  inkMuted: '#8a97a8',
  grid: '#eef1f5',
  axis: '#d5dbe3',
  primary: '#2a78d6',
  primarySoft: '#e8f1fc',
  muted: '#b8c4d4',
  categorical: ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948'],
  status: {
    critical: '#d03b3b',
    criticalSoft: '#fdeeee',
    serious: '#e5672a',
    warning: '#d98a00',
    warningSoft: '#fff5df',
    good: '#1a9c5b',
    goodSoft: '#e9f7ef',
  },
} as const;

export const FONT_FAMILY = 'Inter';
const FONT_DIR = path.resolve(__dirname, '../../assets/fonts');
const FONT_FILES = ['Inter-Regular.ttf', 'Inter-Medium.ttf', 'Inter-SemiBold.ttf', 'Inter-Bold.ttf']
  .map((f) => path.join(FONT_DIR, f))
  .filter((f) => fs.existsSync(f));

const CARD_RADIUS = 14;
const PIXEL_RATIO = 2;

export interface ChartImage {
  filename: string;
  title: string;
  png: Buffer;
}

/** Wraps an SVG in a white rounded card with a hairline border, then rasterizes at 2x. */
export function svgToPng(innerSvg: string, width: number, height: number, scale = PIXEL_RATIO): Buffer {
  const body = innerSvg.replace(/^<\?xml[^>]*>\s*/, '');
  const card = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="${CARD_RADIUS}" fill="${PALETTE.surface}" stroke="${PALETTE.cardBorder}"/>
  ${body}
</svg>`;
  return new Resvg(card, {
    fitTo: { mode: 'zoom', value: scale },
    font: { fontFiles: FONT_FILES, loadSystemFonts: FONT_FILES.length === 0, defaultFontFamily: FONT_FAMILY, sansSerifFamily: FONT_FAMILY },
    shapeRendering: 2,
    textRendering: 2,
  })
    .render()
    .asPng();
}

/** Shared chrome: Inter, navy title / slate subtitle, generous padding, no animation. */
export function baseOption(title: string, subtitle?: string): echarts.EChartsOption {
  return {
    animation: false,
    backgroundColor: 'transparent',
    textStyle: { fontFamily: FONT_FAMILY, color: PALETTE.ink },
    title: {
      text: title,
      subtext: subtitle,
      left: 32,
      top: 26,
      itemGap: 8,
      textStyle: { fontFamily: FONT_FAMILY, fontSize: 19, fontWeight: 600, color: PALETTE.ink },
      subtextStyle: { fontFamily: FONT_FAMILY, fontSize: 13, color: PALETTE.inkSecondary },
    },
  };
}

export function renderECharts(option: echarts.EChartsOption, width: number, height: number, filename: string, title: string): ChartImage {
  const chart = echarts.init(null, null, { renderer: 'svg', ssr: true, width, height });
  try {
    chart.setOption(option);
    return { filename, title, png: svgToPng(chart.renderToSVGString(), width, height) };
  } finally {
    chart.dispose();
  }
}

/** Long names would crowd the plot; the full name stays in the displayText table. */
export function truncateLabel(label: string, max = 42): string {
  return label.length > max ? `${label.slice(0, max - 1)}…` : label;
}

export const escapeXml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c] as string));

/** Rough Inter text width (px) — enough to size labels and badges without a canvas. */
export function textWidth(text: string, fontSize: number, weight = 400): number {
  let units = 0;
  for (const ch of text) {
    if (/[ilI.,:;'|!]/.test(ch)) units += 0.28;
    else if (/[mwMW]/.test(ch)) units += 0.84;
    else if (/[A-Z0-9]/.test(ch)) units += 0.66;
    else if (ch === ' ') units += 0.27;
    else units += 0.55;
  }
  return units * fontSize * (weight >= 600 ? 1.05 : 1);
}
