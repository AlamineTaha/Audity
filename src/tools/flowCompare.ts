import { z } from 'zod';
import { authService, salesforceService, aiService } from '../services/container';
import { defineTool, ok, fail, zInt, zBool } from './types';

export const compareFlowVersionsTool = defineTool({
  name: 'compare_flow_versions',
  title: 'Compare or analyze Flow versions',
  description:
    'Compares two Flow versions and returns a human-readable narrative explaining what changed, the business impact, ' +
    'and security concerns. Modes: (1) flowName + versionA + versionB compares two specific versions; (2) flowName only ' +
    'compares the latest two versions; (3) flowName + analyze=true explains the latest version only. Use when the user ' +
    'asks to compare, diff, or see what changed between Flow versions.',
  inputSchema: z.object({
    flowName: z.string({ error: 'flowName is required (label or API name)' })
      .trim()
      .min(1, 'flowName is required (label or API name)')
      .describe('Flow label or API name.'),
    versionA: zInt().min(1, 'versionA must be a positive integer').optional()
      .describe('First version number (defaults to latest - 1).'),
    versionB: zInt().min(1, 'versionB must be a positive integer').optional()
      .describe('Second version number (defaults to latest).'),
    analyze: zBool().optional().describe('If true, analyze the latest version only (no comparison).'),
  }),
  async handler(ctx, input) {
    try {
      const orgId = ctx.tenant.orgId;
      const { flowName, versionA, versionB } = input;
      const analyzeOnly = input.analyze === true;

      console.log(`[CompareFlow][START] orgId=${orgId} flowName=${flowName} versionA=${String(versionA)} versionB=${String(versionB)} analyzeOnly=${analyzeOnly}`);

      const settings = await authService.getOrgSettings(orgId);
      if (!settings) {
        return fail(400, 'Could not load org settings');
      }

      if (analyzeOnly) {
        let latest;
        try {
          latest = await salesforceService.getLatestFlowVersion(orgId, flowName);
        } catch (sfError) {
          console.error(`[CompareFlow][SF] Failed to fetch latest flow version orgId=${orgId} flowName=${flowName}:`, sfError);
          throw sfError;
        }
        let analysis: string;
        try {
          analysis = await aiService.analyzeFlowVersion(
            latest.metadata, latest.developerName, latest.version, settings
          );
        } catch (llmError) {
          console.error(`[CompareFlow][LLM] Failed to analyze latest flow version orgId=${orgId} flowName=${flowName}:`, llmError);
          throw llmError;
        }
        const flowUrl = `${settings.instanceUrl}/builder_platform_interaction/flowBuilder.app?flowDefId=${latest.definitionId}`;
        const displayText = `Flow: ${latest.label} (v${latest.version})\n\n${analysis}\n\nOpen in Flow Builder: ${flowUrl}`;
        console.log(`[CompareFlow][SUCCESS] orgId=${orgId} flowName=${flowName} mode=analyze`);
        return ok({ displayText });
      }

      if (versionA !== undefined && versionB !== undefined && versionA === versionB) {
        return fail(400, 'versionA and versionB must be different');
      }

      let versions;
      try {
        versions = await salesforceService.getFlowVersionsByNumber(orgId, flowName, versionA, versionB);
      } catch (sfError) {
        console.error(`[CompareFlow][SF] Failed to fetch flow versions orgId=${orgId} flowName=${flowName}:`, sfError);
        throw sfError;
      }

      const older = versions.versionA.version < versions.versionB.version ? versions.versionA : versions.versionB;
      const newer = versions.versionA.version < versions.versionB.version ? versions.versionB : versions.versionA;

      let comparison: string;
      try {
        comparison = await aiService.compareFlowVersions(
          older.metadata, newer.metadata,
          versions.developerName,
          older.version, newer.version,
          settings
        );
      } catch (llmError) {
        console.error(`[CompareFlow][LLM] Failed to compare flow versions orgId=${orgId} flowName=${flowName}:`, llmError);
        throw llmError;
      }

      const flowUrl = `${settings.instanceUrl}/builder_platform_interaction/flowBuilder.app?flowDefId=${versions.definitionId}`;
      const displayText = `Flow: ${versions.label} — Version ${older.version} vs Version ${newer.version}\n\n${comparison}\n\nOpen in Flow Builder: ${flowUrl}`;

      console.log(`[CompareFlow][SUCCESS] orgId=${orgId} flowName=${flowName} mode=compare`);
      return ok({ displayText });
    } catch (error) {
      console.error('[CompareFlow][UNHANDLED] Error in compare-flow-versions endpoint:', error);
      return fail(500, error instanceof Error ? error.message : 'Internal server error');
    }
  },
});

export const flowCompareTools = [compareFlowVersionsTool];
