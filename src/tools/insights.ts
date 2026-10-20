import { z } from 'zod';
import { EARLIER_VERSIONS_ID, ownershipDisplayText } from '../analysis/flowOwnership';
import { HOTSPOT_CATEGORIES, hotspotsDisplayText } from '../analysis/hotspots';
import { hotspotsChart, ownershipShareChart, ownershipTimelineChart } from '../charts/insightCharts';
import { loadChangeHotspots, loadFlowOwnership } from '../services/insightsService';
import { defineTool, fail, ok, ToolImage, zInt } from './types';

/** A chart failing to render must not lose the answer; the displayText carries the same data. */
async function renderCharts(renders: Array<() => Promise<ToolImage>>): Promise<ToolImage[]> {
  const images: ToolImage[] = [];
  for (const render of renders) {
    try {
      images.push(await render());
    } catch (error) {
      console.error('[Insights] Chart rendering failed:', error);
    }
  }
  return images;
}

export const getFlowOwnershipTool = defineTool({
  name: 'get_flow_ownership',
  title: 'Flow Ownership (who really built a Flow)',
  description:
    'Works out who really owns a Flow, like "git blame": for every field of the live version it finds who last changed it, ' +
    'across the version history. Returns each person\'s share of the live logic, their change effort (fields changed, not number ' +
    'of saves), versions, last change, a bus-factor warning, and whether the most recent editor is actually a minor contributor. ' +
    'Includes charts. Use for "who owns Lead_Routing?", "who really built this flow?", "who should I ask about X?", ' +
    '"is the last person who changed it responsible for it?".',
  inputSchema: z.object({
    flowName: z.string().trim().min(1, 'flowName is required').describe('Flow API name or label, e.g. "Lead_Routing".'),
    maxVersions: zInt().min(2).max(100).default(30).describe('How many recent versions to analyze (default 30).'),
  }),
  async handler(ctx, { flowName, maxVersions }) {
    let data;
    try {
      data = await loadFlowOwnership(ctx.tenant.orgId, flowName, maxVersions);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return fail(message.includes('not found') ? 404 : 500, message);
    }
    const { result } = data;
    const name = data.developerName;
    const images = result.timeline.length
      ? await renderCharts([() => ownershipShareChart(name, result), () => ownershipTimelineChart(name, result)])
      : [];

    const displayText =
      ownershipDisplayText(name, result) +
      (data.versionsFailed ? `\n\n_${data.versionsFailed} version(s) could not be loaded and were skipped._` : '');

    return {
      body: {
        success: true,
        displayText,
        flowApiName: name,
        flowLabel: data.label,
        latestVersion: result.latestVersion,
        versionsAnalyzed: data.versionsAnalyzed,
        mainOwner: result.mainOwner?.name ?? null,
        latestEditor: result.latestEditor?.name ?? null,
        busFactorRisk: result.busFactorRisk,
        owners: result.owners.map((o) => ({
          name: o.name,
          isEarlierVersions: o.authorId === EARLIER_VERSIONS_ID,
          liveShare: Math.round(o.liveShare * 1000) / 10,
          effortFields: o.effort,
          versions: o.versions,
          lastChange: o.lastChange ?? null,
        })),
        timeline: result.timeline,
      },
      images,
    };
  },
});

export const getChangeHotspotsTool = defineTool({
  name: 'get_change_hotspots',
  title: 'Change Hotspots (most-changed components)',
  description:
    'Ranks the org components (Flows, permission sets/profiles, objects and fields, validation rules, layouts, Apex) that were ' +
    'changed most often in a period, with how many different people changed each one. System noise (permission set group ' +
    'recalculations, automated users) is excluded. Based on the long-term audit archive. Includes a chart. Use for "which flows ' +
    'change the most?", "hotspots", "what is changed most often?", "what is fragile in our org?".',
  inputSchema: z.object({
    days: zInt().min(1).max(365).default(30).describe('Look-back window in days (default 30, max 365).'),
    category: z.enum(HOTSPOT_CATEGORIES).optional().describe(`Optional category filter: ${HOTSPOT_CATEGORIES.join(', ')}.`),
    limit: zInt().min(1).max(25).default(10).describe('Number of components to return (default 10).'),
  }),
  async handler(ctx, { days, category, limit }) {
    const data = await loadChangeHotspots(ctx.tenant.orgId, days, category, limit);
    if (!data.archiveOldest) {
      return ok({ displayText: 'The audit archive is still empty for this org — it fills on the next monitoring cycle (every 10 minutes).', hotspots: [] });
    }
    let displayText = hotspotsDisplayText(data, days, category);
    const windowStart = Date.now() - days * 24 * 60 * 60 * 1000;
    if (data.archiveOldest.getTime() > windowStart + 24 * 60 * 60 * 1000) {
      displayText += `\n\n_The archive only goes back to ${data.archiveOldest.toISOString().slice(0, 10)}, so older changes are not counted._`;
    }
    const images = data.hotspots.length ? await renderCharts([() => hotspotsChart(data, days)]) : [];
    return {
      body: { success: true, displayText, days, category: category ?? null, totalChanges: data.totalChanges, excludedNoise: data.excludedNoise, hotspots: data.hotspots },
      images,
    };
  },
});

export const insightTools = [getFlowOwnershipTool, getChangeHotspotsTool];
