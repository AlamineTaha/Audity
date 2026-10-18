import { z } from 'zod';
import { authService, salesforceService, aiService } from '../services/container';
import { defineTool, ok, fail } from './types';

const objectApiNameField = () =>
  z.string({ error: 'objectApiName is required' })
    .trim()
    .min(1, 'objectApiName is required')
    .describe('Object API name (e.g. Account, Opportunity, CustomObject__c).');

export const explainMetadataTool = defineTool({
  name: 'explain_metadata',
  title: 'Explain Validation Rule or Formula Field',
  description:
    'Uses AI to explain a single Validation Rule or Formula Field in business terms. Use when the user asks what a ' +
    'specific validation rule or formula field does. objectName is required when type is FormulaField.',
  inputSchema: z.object({
    name: z.string({ error: 'Missing required parameters: name and type are required' })
      .min(1, 'Missing required parameters: name and type are required')
      .describe('Name of the Validation Rule or Formula Field.'),
    type: z.enum(['ValidationRule', 'FormulaField'], { error: 'type must be either "ValidationRule" or "FormulaField"' })
      .describe('Type of metadata.'),
    objectName: z.string().optional().describe('Object name (required for FormulaField, e.g. Account).'),
  }),
  async handler(ctx, input) {
    try {
      const orgId = ctx.tenant.orgId;
      const { name, type, objectName } = input;

      if (type === 'FormulaField' && !objectName) {
        return fail(400, 'objectName is required when type is "FormulaField"');
      }

      const settings = await authService.getOrgSettings(orgId);
      if (!settings) {
        return fail(404, `Organization ${orgId} not found or not configured`);
      }

      let metadata: unknown = null;
      let explanation: string;

      if (type === 'ValidationRule') {
        const validationMetadata = await salesforceService.getValidationRuleMetadata(orgId, name);
        if (!validationMetadata) {
          return fail(404, `Validation Rule "${name}" not found`);
        }
        metadata = { errorConditionFormula: validationMetadata.errorConditionFormula, id: validationMetadata.id };
        explanation = await aiService.interpretMetadataChange(metadata, 'ValidationRule', name, settings);
      } else {
        const formulaMetadata = await salesforceService.getFormulaFieldMetadata(orgId, name, objectName as string);
        if (!formulaMetadata) {
          return fail(404, `Formula Field "${name}" not found on object "${objectName}"`);
        }
        metadata = formulaMetadata;
        explanation = await aiService.interpretMetadataChange(formulaMetadata, 'FormulaField', `${objectName}.${name}`, settings);
      }

      const label = type === 'FormulaField' ? `${objectName}.${name}` : name;
      const displayText = `${type}: ${label}\n\n${explanation}`;

      return ok({
        displayText,
        name,
        type,
        objectName: type === 'FormulaField' ? objectName : undefined,
        explanation,
        metadata,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      console.error('Error in explain-metadata endpoint:', error);
      return fail(500, error instanceof Error ? error.message : 'Internal server error');
    }
  },
});

export const analyzeValidationRulesTool = defineTool({
  name: 'analyze_validation_rules',
  title: 'Object Validation Audit',
  description:
    'Retrieves all validation rules for a Salesforce object and uses AI to analyze them. Returns a Validation Health ' +
    'summary with categories and suggestions for vague error messages. Use when the user asks to audit or review ' +
    'validation rules on an object.',
  inputSchema: z.object({
    objectApiName: objectApiNameField(),
  }),
  async handler(ctx, input) {
    try {
      const orgId = ctx.tenant.orgId;
      const { objectApiName } = input;

      const settings = await authService.getOrgSettings(orgId);
      if (!settings) {
        return fail(404, `Organization ${orgId} not found or not configured`);
      }

      const rules = await salesforceService.getValidationRulesForObjectAudit(orgId, objectApiName);

      if (rules.length === 0) {
        return fail(404, `No validation rules found for object ${objectApiName}`);
      }

      const analysis = await aiService.analyzeValidationRulesForObject(objectApiName, rules, settings);

      const activeCount = rules.filter(r => r.active).length;

      let displayText = `Validation Rules for ${objectApiName}: ${rules.length} total, ${activeCount} active.\n\n`;
      displayText += analysis.summary + '\n';

      if (analysis.categories.length > 0) {
        displayText += '\nCategories:\n';
        for (const cat of analysis.categories) {
          displayText += `  ${cat.name} (${cat.rules.length} rule(s))\n`;
        }
      }

      if (analysis.vagueErrorSuggestions.length > 0) {
        displayText += `\n${analysis.vagueErrorSuggestions.length} rule(s) have vague error messages that should be improved.`;
        displayText += ' Ask me for the full list of suggestions if you want details.';
      }

      return ok({
        displayText,
        count: rules.length,
        activeCount,
        summary: analysis.summary,
        categories: analysis.categories,
        vagueErrorSuggestions: analysis.vagueErrorSuggestions,
      });
    } catch (error) {
      console.error('Error in analyze-validation-rules endpoint:', error);
      return fail(500, error instanceof Error ? error.message : 'Internal server error');
    }
  },
});

export const explainValidationRulesTool = defineTool({
  name: 'explain_validation_rules',
  title: 'Explain Each Validation Rule',
  description:
    'Fetches every validation rule on an object (including formulas) and uses AI to explain each one individually ' +
    'with a summary and impact level (CRITICAL or NORMAL). Use when the user asks for details about each validation ' +
    'rule, wants to know what specific rules do, or asks about the impact of validation rules on an object.',
  inputSchema: z.object({
    objectApiName: objectApiNameField(),
  }),
  async handler(ctx, input) {
    try {
      const orgId = ctx.tenant.orgId;
      const { objectApiName } = input;

      const settings = await authService.getOrgSettings(orgId);
      if (!settings) {
        return fail(404, `Organization ${orgId} not found or not configured`);
      }

      console.log(`[Explain Validation Rules] Fetching rules for ${objectApiName}`);
      const rules = await salesforceService.getValidationRulesDetailedForAudit(orgId, objectApiName);

      if (rules.length === 0) {
        return fail(404, `No validation rules found for object ${objectApiName}`);
      }

      console.log(`[Explain Validation Rules] Analyzing ${rules.length} rule(s) with AI`);
      const analysis = await aiService.analyzeValidationRulesDetailed(objectApiName, rules, settings);

      const activeCount = rules.filter(r => r.active).length;
      const criticalCount = analysis.filter(r => r.impact === 'CRITICAL').length;

      let displayText = `Validation Rules for ${objectApiName}: ${rules.length} total, ${activeCount} active, ${criticalCount} critical.\n`;

      for (const rule of analysis) {
        const status = rule.active ? 'Active' : 'Inactive';
        displayText += `\n${rule.validationName} (${status})\n`;
        displayText += `  ${rule.summary}\n`;
        displayText += `  Impact: ${rule.impact} - ${rule.impactReason}\n`;
      }

      return ok({
        displayText,
        objectApiName,
        count: rules.length,
        activeCount,
        criticalCount,
        rules: analysis,
      });
    } catch (error) {
      console.error('Error in explain-validation-rules endpoint:', error);
      return fail(500, error instanceof Error ? error.message : 'Internal server error');
    }
  },
});

export const metadataTools = [explainMetadataTool, analyzeValidationRulesTool, explainValidationRulesTool];
