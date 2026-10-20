/**
 * Server-side chart rendering: Vega-Lite spec -> Vega SVG (no canvas) -> PNG via resvg.
 * No external chart service, so org data never leaves the server.
 */

import { Resvg } from '@resvg/resvg-js';

// vega / vega-lite are ESM-only (with top-level await), so they can't be require()d from this
// CommonJS build. A Function-wrapped import() survives TypeScript's CommonJS transform.
const importEsm = new Function('specifier', 'return import(specifier)') as <T>(specifier: string) => Promise<T>;

interface VegaModule {
  parse(spec: unknown): unknown;
  View: new (runtime: unknown, options: { renderer: 'none' }) => { toSVG(scaleFactor?: number): Promise<string>; finalize(): void };
}
interface VegaLiteModule {
  compile(spec: unknown): { spec: unknown };
}

// Reference palette (dataviz skill, light mode). Categorical order is fixed, never cycled.
export const PALETTE = {
  surface: '#fcfcfb',
  inkPrimary: '#0b0b0b',
  inkSecondary: '#52514e',
  inkMuted: '#898781',
  grid: '#e1e0d9',
  axis: '#c3c2b7',
  categorical: ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948'],
  critical: '#d03b3b',
} as const;

const FONT = 'DejaVu Sans, Helvetica, Arial, sans-serif';

/** Recessive chrome: hairline solid grid/axes, text in ink tokens, never series colors. */
export const BASE_CONFIG = {
  background: PALETTE.surface,
  padding: 16,
  font: FONT,
  view: { stroke: null },
  title: { anchor: 'start', fontSize: 15, fontWeight: 600, color: PALETTE.inkPrimary, subtitleColor: PALETTE.inkSecondary, subtitleFontSize: 12, offset: 14 },
  axis: {
    labelColor: PALETTE.inkSecondary,
    titleColor: PALETTE.inkSecondary,
    labelFontSize: 11,
    titleFontSize: 11,
    titleFontWeight: 500,
    gridColor: PALETTE.grid,
    gridWidth: 1,
    domainColor: PALETTE.axis,
    tickColor: PALETTE.axis,
  },
  legend: { labelColor: PALETTE.inkSecondary, titleColor: PALETTE.inkSecondary, labelFontSize: 11, titleFontSize: 11, orient: 'top' },
  text: { color: PALETTE.inkSecondary, fontSize: 11 },
};

let modules: Promise<[VegaModule, VegaLiteModule]> | null = null;
const loadModules = () => {
  if (!modules) modules = Promise.all([importEsm<VegaModule>('vega'), importEsm<VegaLiteModule>('vega-lite')]);
  return modules;
};

export interface ChartImage {
  filename: string;
  title: string;
  png: Buffer;
}

/** Renders a Vega-Lite spec (BASE_CONFIG merged in) to a 2x PNG. */
export async function renderVegaLite(spec: Record<string, unknown>, filename: string, title: string): Promise<ChartImage> {
  const [vega, vl] = await loadModules();
  const full = { $schema: 'https://vega.github.io/schema/vega-lite/v6.json', ...spec, config: { ...BASE_CONFIG, ...(spec.config as object | undefined) } };
  const view = new vega.View(vega.parse(vl.compile(full).spec), { renderer: 'none' });
  try {
    const svg = await view.toSVG();
    const png = new Resvg(svg, {
      background: PALETTE.surface,
      fitTo: { mode: 'zoom', value: 2 },
      font: { loadSystemFonts: true, sansSerifFamily: process.platform === 'linux' ? 'DejaVu Sans' : 'Helvetica' },
    })
      .render()
      .asPng();
    return { filename, title, png };
  } finally {
    view.finalize();
  }
}

/** Long names would push the plot off-canvas; the full name stays in the displayText table. */
export function truncateLabel(label: string, max = 42): string {
  return label.length > max ? `${label.slice(0, max - 1)}…` : label;
}
