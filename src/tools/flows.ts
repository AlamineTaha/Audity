import { z } from 'zod';
import { authService, salesforceService, aiService } from '../services/container';
import { defineTool, fail, ok, ToolResult, zInt } from './types';

function errorResult(error: unknown, logLabel: string): ToolResult {
  console.error(`Error in ${logLabel} endpoint:`, error);
  const errorMessage = error instanceof Error ? error.message : 'Internal server error';
  return fail(errorMessage.includes('not found') ? 404 : 500, errorMessage);
}

const flowApiNameField = z
  .string({ error: 'Missing required fields: flowApiName and targetVersionNumber are required' })
  .min(1, 'Missing required fields: flowApiName and targetVersionNumber are required')
  .describe('API name (DeveloperName) or label of the Flow, e.g. "Lead_Assignment_Flow".');

const targetVersionField = z.coerce
  .number({ error: 'Missing required fields: flowApiName and targetVersionNumber are required' })
  .int()
  .describe('Flow version number to activate, e.g. 3.');

export const analyzeFlowChangesTool = defineTool({
  name: 'analyze_flow_changes',
  title: 'Analyze Flow Changes',
  description:
    'Analyzes what changed in a Flow between its current and previous version using AI, and returns a plain-English ' +
    'summary, the list of changes, a risk rating, dependencies (subflows, buttons, quick actions), today\'s versions and ' +
    'a recommended stable version to revert to. Use when the user asks what changed in a specific Flow, whether a Flow ' +
    'change is risky, or whether it should be reverted.',
  inputSchema: z.object({
    flowName: z
      .string({ error: 'Missing required field: flowName' })
      .min(1, 'Missing required field: flowName')
      .describe('API name of the Flow to analyze, e.g. "My_Flow".'),
  }),
  async handler(ctx, { flowName }) {
    const orgId = ctx.tenant.orgId;

    try {
      const settings = await authService.getOrgSettings(orgId);
      if (!settings) {
        return fail(404, 'Organization settings not found for this tenant. Please re-authenticate at /auth/authorize');
      }

      let versions;
      try {
        versions = await salesforceService.getFlowVersions(orgId, flowName);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        if (errorMessage.includes('not found')) {
          return fail(404, `Flow not found: ${flowName}`, { flowName });
        }
        throw error;
      }

      const diff = await aiService.generateSummary(
        versions.previous,
        versions.current,
        flowName,
        settings
      );

      const versionsToday = await salesforceService.getFlowVersionsInTimeWindow(orgId, flowName, 24);
      const versionNumbersToday = versionsToday.map(v => v.versionNumber);
      const recommendedStableVersion = await salesforceService.findLastStableVersion(orgId, flowName, 24);

      let revertPrompt = '';
      if (versionNumbersToday.length > 0) {
        revertPrompt = recommendedStableVersion
          ? `Would you like to activate Version ${recommendedStableVersion} (Last Stable), a specific version, or keep the current changes?`
          : `Would you like to activate a specific version or keep the current changes?`;
      } else {
        revertPrompt = 'No changes detected today. No revert action needed.';
      }

      let dependencies;
      try {
        dependencies = await salesforceService.getFlowDependencyReport(orgId, flowName);
      } catch (error) {
        console.error(`Error fetching dependency report for ${flowName}:`, error);
        dependencies = {
          reportedDependencies: [],
          uiDependencies: { buttons: [], quickActions: [] },
          subflowDependencies: [],
          securityNote: 'Dependency analysis could not be completed. Error occurred during metadata query.',
          limitations: [
            'Analysis limited to Metadata (Subflows/Buttons). External callers (Apex/LWC) were not scanned.',
            'Dependency analysis could not be completed due to an error. Please verify manually.',
          ],
        };
      }

      let revertImpact;
      if (recommendedStableVersion) {
        try {
          revertImpact = await salesforceService.checkRevertImpact(orgId, flowName, recommendedStableVersion);
        } catch (error) {
          console.error(`Error checking revert impact for ${flowName}:`, error);
          revertImpact = {
            warnings: ['Could not analyze revert impact. Please verify manually before reverting.'],
            activeSessions: 0,
            canRevert: false,
          };
        }
      } else {
        revertImpact = { warnings: [], activeSessions: 0, canRevert: true };
      }

      let riskAnalysis;
      try {
        const flowMetadata = await salesforceService.getFlowMetadata(orgId, flowName);
        if (flowMetadata) {
          const metadataStr = JSON.stringify(flowMetadata).toLowerCase();
          const hasPII = /(ssn|social|credit|card|password|pin|salary|wage|compensation)/i.test(metadataStr);
          const hasModifyAll = /modifyall|viewall/i.test(metadataStr);

          if (hasModifyAll) {
            riskAnalysis = {
              riskLevel: 'CRITICAL' as const,
              riskReason: 'Flow contains ModifyAll or ViewAll operations which grant access to all records regardless of sharing rules.',
            };
          } else if (hasPII) {
            riskAnalysis = {
              riskLevel: 'HIGH' as const,
              riskReason: 'Flow accesses PII (Personally Identifiable Information) fields. Ensure proper security controls are in place.',
            };
          } else {
            riskAnalysis = {
              riskLevel: 'LOW' as const,
              riskReason: 'No high-risk operations detected in Flow metadata.',
            };
          }
        }
      } catch (error) {
        console.error(`Error analyzing Flow risk:`, error);
        riskAnalysis = {
          riskLevel: 'MEDIUM' as const,
          riskReason: 'Could not complete risk analysis. Please verify manually.',
        };
      }

      let displayText = `Flow: ${diff.flowName}\n\n${diff.summary}\n`;

      if (diff.changes.length > 0) {
        displayText += '\nChanges:\n';
        for (const c of diff.changes) {
          displayText += `  - ${c}\n`;
        }
      }

      if (riskAnalysis) {
        displayText += `\nRisk: ${riskAnalysis.riskLevel} - ${riskAnalysis.riskReason}\n`;
      }

      if (versionNumbersToday.length > 0) {
        displayText += `\n${versionNumbersToday.length} change(s) detected today. ${revertPrompt}`;
      }

      return ok({
        displayText,
        flowName: diff.flowName,
        summary: diff.summary,
        changes: diff.changes,
        revertOptions: {
          summary: `${versionNumbersToday.length} change(s) detected today.`,
          versionsToday: versionNumbersToday,
          recommendedStableVersion,
          revertPrompt,
        },
        dependencies,
        riskAnalysis,
        revertImpact,
      });
    } catch (error) {
      console.error('Error in analyze-flow endpoint:', error);
      const errorMessage = error instanceof Error ? error.message : 'Internal server error';
      return fail(500, errorMessage);
    }
  },
});

export const checkFlowRevertImpactTool = defineTool({
  name: 'check_flow_revert_impact',
  title: 'Check Flow Revert Impact',
  description:
    'Checks whether it is safe to revert a Flow to a given version before doing it: returns warnings (e.g. removed ' +
    'elements, dependent subflows) and the number of in-progress Flow interviews that would be affected. Always call ' +
    'this before activate_flow_version when the user asks to revert or roll back a Flow.',
  inputSchema: z.object({
    flowApiName: flowApiNameField,
    targetVersionNumber: targetVersionField,
  }),
  async handler(ctx, { flowApiName, targetVersionNumber }) {
    try {
      const impact = await salesforceService.checkRevertImpact(ctx.tenant.orgId, flowApiName, targetVersionNumber);

      let displayText = impact.canRevert
        ? `Safe to revert ${flowApiName} to version ${targetVersionNumber}.`
        : `Reverting ${flowApiName} to version ${targetVersionNumber} is NOT recommended.`;

      if (impact.warnings.length > 0) {
        displayText += '\n\nWarnings:\n' + impact.warnings.map(w => `  - ${w}`).join('\n');
      }
      if (impact.activeSessions > 0) {
        displayText += `\n\nNote: ${impact.activeSessions} active flow interview(s) currently in progress will be affected.`;
      }

      return ok({
        displayText,
        warnings: impact.warnings,
        activeSessions: impact.activeSessions,
        canRevert: impact.canRevert,
      });
    } catch (error) {
      return errorResult(error, 'check-revert-impact');
    }
  },
});

export const activateFlowVersionTool = defineTool({
  name: 'activate_flow_version',
  title: 'Activate Flow Version (Safe Revert)',
  description:
    'Activates a specific version of a Flow, deactivating the currently active one. This changes the org: only call ' +
    'it after the user explicitly confirms, and preferably after check_flow_revert_impact. Use when the user asks to ' +
    'revert, roll back, or activate a particular Flow version.',
  mutating: true,
  inputSchema: z.object({
    flowApiName: flowApiNameField,
    targetVersionNumber: targetVersionField,
  }),
  async handler(ctx, { flowApiName, targetVersionNumber }) {
    try {
      const result = await salesforceService.activateSpecificVersion(ctx.tenant.orgId, flowApiName, targetVersionNumber);

      let displayText = result.message;
      if (result.success && result.previousActiveVersion) {
        displayText += ` Previous active version was ${result.previousActiveVersion}.`;
      }
      if (result.warnings?.length) {
        displayText += '\n\nWarnings:\n' + result.warnings.map(w => `  - ${w}`).join('\n');
      }

      return {
        status: 200,
        body: {
          success: result.success,
          displayText,
          message: result.message,
          previousActiveVersion: result.previousActiveVersion,
          newActiveVersion: result.newActiveVersion,
          warnings: result.warnings,
        },
      };
    } catch (error) {
      return errorResult(error, 'activate-version');
    }
  },
});

export const revertFlowTodayTool = defineTool({
  name: 'revert_flow_today',
  title: 'Revert Today\'s Flow Changes',
  description:
    'Undoes all changes made to a Flow within the last N hours (default 24) by re-activating the last stable version ' +
    'from before that window. This changes the org: only call it after the user explicitly confirms. Use when the user ' +
    'asks to undo everything changed today on a Flow.',
  mutating: true,
  inputSchema: z.object({
    flowApiName: z
      .string({ error: 'Missing required field: flowApiName' })
      .min(1, 'Missing required field: flowApiName')
      .describe('API name (DeveloperName) or label of the Flow to revert.'),
    hours: zInt().default(24).describe('Look-back window in hours; changes inside it are reverted. Default 24.'),
  }),
  async handler(ctx, { flowApiName, hours }) {
    try {
      const result = await salesforceService.batchRevertTodayChanges(ctx.tenant.orgId, flowApiName, hours);

      let displayText = result.message;
      if (result.success && result.stableVersion) {
        displayText += ` Reverted to stable version ${result.stableVersion}.`;
      }
      if (result.warnings?.length) {
        displayText += '\n\nWarnings:\n' + result.warnings.map(w => `  - ${w}`).join('\n');
      }

      return {
        status: 200,
        body: {
          success: result.success,
          displayText,
          message: result.message,
          stableVersion: result.stableVersion,
          previousActiveVersion: result.previousActiveVersion,
          warnings: result.warnings,
        },
      };
    } catch (error) {
      return errorResult(error, 'revert-today');
    }
  },
});

export const listFlowVersionsTool = defineTool({
  name: 'list_flow_versions',
  title: 'List Flow Versions',
  description:
    'Lists the versions of a Flow created or modified within the last N hours (default 24), with version number, ' +
    'status (Active, Draft, Obsolete) and version Id. Use when the user asks which versions of a Flow exist, which ' +
    'one is active, or what version to revert to.',
  inputSchema: z.object({
    flowApiName: z
      .string({ error: 'Missing required query parameter: flowApiName' })
      .min(1, 'Missing required query parameter: flowApiName')
      .describe('API name (DeveloperName) or label of the Flow.'),
    hours: zInt().default(24).describe('Look-back window in hours. Default 24.'),
  }),
  async handler(ctx, { flowApiName, hours }) {
    try {
      const versions = await salesforceService.getFlowVersionsInTimeWindow(ctx.tenant.orgId, flowApiName, hours);

      let displayText = `${versions.length} version(s) of ${flowApiName} in the last ${hours} hour(s).\n`;
      if (versions.length > 0) {
        for (const v of versions) {
          displayText += `  - Version ${v.versionNumber}: ${v.status || 'Unknown status'} (${v.versionId})\n`;
        }
      } else {
        displayText += 'No versions found in this time window.';
      }

      return ok({
        displayText,
        flowApiName,
        versions,
        timeWindow: `${hours} hours`,
      });
    } catch (error) {
      return errorResult(error, 'versions');
    }
  },
});

export const flowTools = [
  analyzeFlowChangesTool,
  checkFlowRevertImpactTool,
  activateFlowVersionTool,
  revertFlowTodayTool,
  listFlowVersionsTool,
];
