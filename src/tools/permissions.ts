import { z } from 'zod';
import { authService, salesforceService, aiService } from '../services/container';
import { defineTool, ok, fail } from './types';

export const analyzePermissionTool = defineTool({
  name: 'analyze_permission',
  title: 'Analyze Permission Set Security',
  description:
    'Fetches a Permission Set or Profile by name and performs an AI-powered security audit. Returns object access, ' +
    'system permissions, risk levels, and recommendations. Use when the user asks to audit, review, or analyze a ' +
    'specific Permission Set or Profile.',
  inputSchema: z.object({
    permissionSetName: z.string({ error: 'permissionSetName is required' })
      .min(1, 'permissionSetName is required')
      .describe("API Name or Label of the Permission Set or Profile to analyze (e.g. 'Sales_User', 'System Administrator')."),
  }),
  async handler(ctx, input) {
    try {
      const orgId = ctx.tenant.orgId;
      const { permissionSetName } = input;

      console.log(`[Analyze Permission] Fetching permission set: "${permissionSetName}"`);
      const psData = await salesforceService.getPermissionSetForAudit(orgId, permissionSetName);
      console.log(`[Analyze Permission] Found "${psData.label}" with ${psData.objectPermissions.length} object permissions and ${psData.systemPermissions.length} system permissions`);

      const settings = await authService.getOrgSettings(orgId);
      if (!settings) {
        return fail(500, 'Could not load org settings for AI analysis');
      }

      const analysis = await aiService.analyzePermissionSet(psData, settings);

      const typeLabel = psData.isOwnedByProfile
        ? `Profile: ${psData.profileName || psData.label}`
        : `Permission Set: ${psData.label}`;

      let displayText = `${typeLabel} (assigned to ${psData.assignedUserCount} user(s))\n`;
      displayText += `Overall Risk: ${analysis.overallRiskLevel}\n\n`;
      displayText += analysis.summary + '\n';

      if (analysis.risks.length > 0) {
        displayText += '\nRisks:\n';
        for (const risk of analysis.risks) {
          displayText += `  ${risk.severity}: ${risk.description}\n`;
          displayText += `  Recommendation: ${risk.recommendation}\n\n`;
        }
      }

      return ok({
        displayText,
        permissionSet: {
          id: psData.id,
          name: psData.name,
          label: psData.label,
          isProfile: psData.isOwnedByProfile,
          profileName: psData.profileName,
          description: psData.description,
          license: psData.license,
          assignedUsers: psData.assignedUserCount,
        },
        analysis: {
          summary: analysis.summary,
          overallRiskLevel: analysis.overallRiskLevel,
          objectAccess: analysis.objectAccess,
          systemPermissions: analysis.systemPermissions,
          risks: analysis.risks,
        },
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      console.error('Error in analyze-permission endpoint:', error);
      const errorMessage = error instanceof Error ? error.message : 'Internal server error';
      return fail(errorMessage.includes('not found') ? 404 : 500, errorMessage);
    }
  },
});

export const findPermissionSourcesTool = defineTool({
  name: 'find_permission_sources',
  title: 'Find Permission Sources',
  description:
    'Reverse permission lookup. Given a natural-language query, returns every Permission Set and Profile that grants ' +
    'that access. Use when the user asks WHO or WHAT grants a permission, e.g. "Which permissions let me edit Accounts?", ' +
    '"What gives access to delete Opportunities?", "Who can export reports?". Supported formats: "edit Account" (object), ' +
    '"edit Account BillingStreet" (field), "export reports" (system permission).',
  inputSchema: z.object({
    query: z.string({ error: 'query is required' })
      .min(1, 'query is required')
      .describe("Natural-language permission query, e.g. 'edit Account', 'delete Opportunity', 'edit Account BillingStreet', 'export reports'."),
  }),
  async handler(ctx, input) {
    try {
      const orgId = ctx.tenant.orgId;
      const { query } = input;

      console.log(`[Find Permission Sources] Query: "${query}"`);
      const result = await salesforceService.findPermissionSources(orgId, query);
      console.log(`[Find Permission Sources] Found ${result.sources.length} source(s) for "${result.resolvedQuery}"`);

      return ok({
        originalQuery: query,
        resolvedQuery: result.resolvedQuery,
        queryType: result.queryType,
        resolvedObject: result.resolvedObject || null,
        resolvedField: result.resolvedField || null,
        resolvedAction: result.resolvedAction || null,
        resolvedSystemPermission: result.resolvedSystemPermission || null,
        sourceCount: result.sources.length,
        sources: result.sources,
        displayText: result.displayText,
      });
    } catch (error) {
      console.error('Error in find-permission-sources endpoint:', error);
      const errorMessage = error instanceof Error ? error.message : 'Internal server error';
      return fail(errorMessage.includes('Could not understand') ? 400 : 500, errorMessage);
    }
  },
});

export const permissionTools = [analyzePermissionTool, findPermissionSourcesTool];
