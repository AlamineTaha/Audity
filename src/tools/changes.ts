import { z } from 'zod';
import { authService, salesforceService, aiService, monitorService } from '../services/container';
import { defineTool, ok, fail, zInt, zBool } from './types';

export const runChangeCheckTool = defineTool({
  name: 'run_change_check',
  title: 'Force Immediate Change Check',
  description:
    'Triggers the polling engine to check the org for Salesforce setup changes immediately, analyze them with AI, ' +
    'and send Slack alerts. Use when the user asks to check for recent changes, run a scan, or trigger an audit. ' +
    'By default it covers everything since the last check; pass hours to look further back.',
  inputSchema: z.object({
    hours: zInt().min(1, 'hours must be a positive integer').optional()
      .describe('Look back X hours instead of the default (everything since the last check).'),
    debug: zBool().optional().describe('Skip the dedup cache to re-test the same change.'),
    forceImmediate: zBool().optional().describe('Bypass aggregation and alert immediately.'),
    immediate: zBool().optional().describe('Alias of forceImmediate.'),
  }),
  async handler(ctx, input) {
    try {
      const hoursNum = input.hours;
      const forceImmediate = input.forceImmediate === true || input.immediate === true;
      const debugMode = input.debug === true;
      const result = await monitorService.runChangeCheck(hoursNum, forceImmediate, debugMode, ctx.tenant.orgId);

      const timeWindow = hoursNum ? `${hoursNum} hour(s)` : 'since last check';
      const message = result.success
        ? `Manual check completed (${timeWindow}). Found ${result.changesFound} change(s).`
        : 'Manual check completed with errors.';

      let displayText = message;
      if (result.changesFound > 0 && result.changes?.length) {
        const summaryLines = result.changes.slice(0, 10).map((c) =>
          `- ${c.action}: ${c.display || 'No details'} (by ${c.user || 'Unknown'})`
        );
        displayText += '\n\n' + summaryLines.join('\n');
        if (result.changesFound > 10) {
          displayText += `\n... and ${result.changesFound - 10} more change(s).`;
        }
      }
      if (result.errors?.length) {
        displayText += '\n\nErrors: ' + result.errors.join(', ');
      }

      return {
        body: {
          success: result.success,
          displayText,
          message,
          changesFound: result.changesFound,
          errors: result.errors,
          timeWindow: hoursNum ? `${hoursNum} hours` : 'since last check',
          debug: debugMode,
          changes: result.changes || [],
        },
      };
    } catch (error) {
      console.error('Error in trigger-check endpoint:', error);
      const errorMessage = error instanceof Error ? error.message : 'Internal server error';
      return fail(500, errorMessage, { message: errorMessage, changesFound: 0, errors: [errorMessage] });
    }
  },
});

const VALIDATION_ACTIONS = [
  'changedValidationFormula', 'changedValidationMessage', 'newValidation',
  'createdValidationRule', 'changedValidationRule', 'deletedValidationRule',
];
const FORMULA_FIELD_ACTIONS = ['createdCFFormula', 'changedCFFormula', 'deletedCFFormula'];

function extractValidationRuleName(display: string): string | null {
  const patterns = [
    /validation\s+["']([^"']+)["']/i,
    /"([^"]+)"(?:\s+validation|$)/i,
    /(?:ValidationRule|Validation Rule):\s*(.+?)(?:\s|$)/i,
    /validation rule\s+(.+?)(?:\s|$)/i,
    /rule\s+["']?([^"'\s]+)["']?/i,
  ];
  for (const pattern of patterns) {
    const match = display.match(pattern);
    if (match?.[1]) return match[1].replace(/^["']+|["']+$/g, '').trim();
  }
  return null;
}

function extractObjectNameFromSection(section: string): string | null {
  if (!section) return null;
  const match = section.match(/Customize\s+([A-Za-z0-9_]+)/i);
  if (match?.[1]) {
    let objectName = match[1];
    if (objectName.endsWith('s') && objectName.length > 1) {
      objectName = objectName.slice(0, -1);
    }
    return objectName;
  }
  return null;
}

function extractFieldName(display: string): string | null {
  const patterns = [
    /(?:field|formula field):\s*(.+?)(?:\s*\(|$)/i,
    /\.([A-Za-z0-9_]+__c)/,
    /^([A-Za-z0-9_\s]+?)(?:\s*\(|$)/,
    /"([^"]+)"(?:\s+field|$)/i,
  ];
  for (const pattern of patterns) {
    const match = display.match(pattern);
    if (match?.[1]) return match[1].trim();
  }
  return null;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([
    promise,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), ms)),
  ]);
}

interface RecentChange {
  action: string;
  user: string;
  section?: string;
  timestamp: string;
  display?: string;
  id: string;
  explanation?: string;
  metadataName?: string;
  metadataType?: string;
}

export const getRecentChangesTool = defineTool({
  name: 'get_recent_changes',
  title: 'Get Recent Org Activity',
  description:
    'Retrieves metadata changes from the Setup Audit Trail with AI-powered explanations, summarized and grouped by user. ' +
    'Use when the user asks about recent changes, what happened, or who changed what.',
  inputSchema: z.object({
    hours: zInt().min(1, 'hours must be a positive integer').optional()
      .describe('Lookback window in hours (defaults to 24).'),
  }),
  async handler(ctx, input) {
    try {
      const orgId = ctx.tenant.orgId;
      const hoursNum = input.hours ?? 24;

      console.log(`[Recent Changes] Processing request - orgId: ${orgId}, hours: ${hoursNum}`);

      const settings = await authService.getOrgSettings(orgId);
      if (!settings) {
        return fail(404, `Organization ${orgId} not found or not configured`);
      }

      const auditRecords = await salesforceService.queryAuditTrailByHours(orgId, hoursNum);
      console.log(`[Recent Changes] Found ${auditRecords.length} audit record(s)`);

      const CONCURRENCY = 3;
      const PER_RECORD_TIMEOUT_MS = 15_000;
      const changes: RecentChange[] = [];

      for (let i = 0; i < auditRecords.length; i += CONCURRENCY) {
        const batch = auditRecords.slice(i, i + CONCURRENCY);
        const batchResults = await Promise.all(
          batch.map(async (record) => {
            const change: RecentChange = {
              action: record.Action,
              user: record.CreatedBy.Name,
              section: record.Section,
              timestamp: record.CreatedDate,
              display: record.Display,
              id: record.Id,
            };

            try {
              if (VALIDATION_ACTIONS.includes(record.Action)) {
                const ruleName = extractValidationRuleName(record.Display || '');
                if (ruleName) {
                  const enriched = await withTimeout(
                    (async () => {
                      const validationMetadata = await salesforceService.getValidationRuleMetadata(orgId, ruleName);
                      if (validationMetadata) {
                        const metadata = {
                          errorConditionFormula: validationMetadata.errorConditionFormula,
                          id: validationMetadata.id,
                        };
                        return {
                          explanation: await aiService.interpretMetadataChange(metadata, 'ValidationRule', ruleName, settings),
                          metadataName: ruleName,
                          metadataType: 'ValidationRule',
                        };
                      }
                      return null;
                    })(),
                    PER_RECORD_TIMEOUT_MS
                  );
                  if (enriched) Object.assign(change, enriched);
                }
              } else if (FORMULA_FIELD_ACTIONS.includes(record.Action)) {
                const fieldName = extractFieldName(record.Display || '');
                const objectName = extractObjectNameFromSection(record.Section || '') ||
                  (record.Display?.match(/([A-Za-z0-9_]+)\.([A-Za-z0-9_]+)/)?.[1]) ||
                  'Unknown';

                if (fieldName && objectName !== 'Unknown') {
                  const enriched = await withTimeout(
                    (async () => {
                      const formulaMetadata = await salesforceService.getFormulaFieldMetadata(orgId, fieldName, objectName);
                      if (formulaMetadata) {
                        return {
                          explanation: await aiService.interpretMetadataChange(formulaMetadata, 'FormulaField', `${objectName}.${fieldName}`, settings),
                          metadataName: `${objectName}.${fieldName}`,
                          metadataType: 'FormulaField',
                        };
                      }
                      return null;
                    })(),
                    PER_RECORD_TIMEOUT_MS
                  );
                  if (enriched) Object.assign(change, enriched);
                }
              }
            } catch (error) {
              console.warn(`[Recent Changes] Error enriching ${record.Action}:`, error instanceof Error ? error.message : error);
            }

            return change;
          })
        );
        changes.push(...batchResults);
      }

      console.log(`[Recent Changes] Finished processing ${changes.length} records`);

      let displayText = `${changes.length} change(s) found in the last ${hoursNum} hour(s).\n`;
      if (changes.length > 0) {
        const grouped: Record<string, RecentChange[]> = {};
        for (const c of changes) {
          const key = c.user || 'Unknown';
          if (!grouped[key]) grouped[key] = [];
          grouped[key].push(c);
        }
        for (const [user, userChanges] of Object.entries(grouped)) {
          displayText += `\n${user} (${userChanges.length} change(s)):\n`;
          for (const c of userChanges.slice(0, 5)) {
            displayText += `  - ${c.action}: ${c.display || 'No details'}`;
            if (c.explanation) displayText += `\n    ${c.explanation.split('\n')[0]}`;
            displayText += '\n';
          }
          if (userChanges.length > 5) {
            displayText += `  ... and ${userChanges.length - 5} more.\n`;
          }
        }
      } else {
        displayText += 'No changes detected in this time window.';
      }

      return ok({ displayText, count: changes.length, changes });
    } catch (error) {
      console.error('[Recent Changes] Error:', error);
      return fail(500, error instanceof Error ? error.message : 'Internal server error');
    }
  },
});

export const changeTools = [runChangeCheckTool, getRecentChangesTool];
