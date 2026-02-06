/**
 * AI Service for analyzing Flow and CMS changes
 * Supports both Personal (Gemini API Key) and Enterprise (Vertex AI) billing modes
 */

import axios, { AxiosInstance } from 'axios';
import { OrgSettings, AuditDiff } from '../types';

export class AIService {
  private geminiApiKey: string;
  private geminiModel: string;
  private vertexAiEndpoint: string;
  private vertexAiRegion: string;
  private axiosInstance: AxiosInstance;

  constructor() {
    this.geminiApiKey = process.env.GEMINI_API_KEY || '';
    // Use gemini-2.5-flash (latest, best price-performance) or gemini-2.5-pro (powerful reasoning)
    // gemini-1.5-flash and gemini-1.5-pro are deprecated/not available
    this.geminiModel = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
    this.vertexAiEndpoint = process.env.VERTEX_AI_ENDPOINT || 'https://us-central1-aiplatform.googleapis.com/v1/projects';
    this.vertexAiRegion = process.env.VERTEX_AI_REGION || 'us-central1';

    this.axiosInstance = axios.create({
      timeout: 60000, // 60 second timeout for AI calls
    });
  }

  /**
   * Interpret a Validation Rule formula using Gemini AI
   * Provides a human-readable explanation of what the formula does
   * 
   * @param formula Validation rule formula text
   * @param ruleName Name of the validation rule
   * @param settings Org settings for billing mode
   * @returns Human-readable interpretation of the formula
   */
  async interpretValidationFormula(
    formula: string,
    ruleName: string,
    settings: OrgSettings
  ): Promise<string> {
    const prompt = `You are a Salesforce administrator analyzing a Validation Rule formula.

Validation Rule Name: ${ruleName}
Formula: ${formula}

Please provide a clear, concise explanation of what this validation rule does:
1. What condition(s) does it check?
2. When will it trigger (what will cause a validation error)?
3. What is the business purpose or intent?

Keep your response under 200 words and use plain language that a non-technical admin can understand.`;

    try {
      return await this.callLLM(prompt, settings);
    } catch (error) {
      console.error('Error interpreting validation formula:', error);
      throw new Error(`Failed to interpret validation formula: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Translate Validation Rule formula to human-readable explanation
   * Alias for interpretValidationFormula for consistency with MonitorService
   * 
   * @param formula Validation rule formula text
   * @param ruleName Name of the validation rule
   * @param settings Org settings for billing mode
   * @returns Human-readable explanation of the formula
   */
  async translateFormulaToHuman(
    formula: string,
    ruleName: string,
    settings: OrgSettings
  ): Promise<string> {
    return this.interpretValidationFormula(formula, ruleName, settings);
  }

  /**
   * Compare two Validation Rule formulas and explain the differences in human language
   * Similar to generateSummary for Flows, but specifically for Validation Rule formulas
   * 
   * @param oldFormula Previous validation rule formula
   * @param newFormula Current validation rule formula
   * @param ruleName Name of the validation rule
   * @param settings Org settings for billing mode
   * @returns Human-readable explanation of what changed
   */
  async compareValidationRuleFormulas(
    oldFormula: string | null,
    newFormula: string,
    ruleName: string,
    settings: OrgSettings
  ): Promise<string> {
    if (!oldFormula) {
      // No previous version found - explain the current formula
      return this.interpretValidationFormula(newFormula, ruleName, settings);
    }

    const prompt = `You are a Salesforce administrator analyzing changes to a Validation Rule formula.

Validation Rule Name: ${ruleName}

PREVIOUS FORMULA:
${oldFormula}

NEW FORMULA:
${newFormula}

Please provide a clear, concise explanation of what changed:
1. What was removed or modified in the old formula?
2. What was added or changed in the new formula?
3. What is the impact of these changes? (e.g., stricter validation, relaxed rules, new conditions)
4. What business scenarios will be affected?

Keep your response under 300 words and use plain language that a non-technical admin can understand.
Focus on the differences and their business impact.`;

    try {
      return await this.callLLM(prompt, settings);
    } catch (error) {
      console.error('Error comparing validation rule formulas:', error);
      throw new Error(`Failed to compare validation rule formulas: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Interpret any Salesforce metadata change in human-readable business terms
   * Generic method that works for Flows, Validation Rules, Custom Fields, etc.
   * 
   * @param metadata Metadata object or formula string
   * @param type Type of metadata: 'Flow', 'ValidationRule', 'CustomField', etc.
   * @param name Name of the metadata item
   * @param settings Org settings for billing mode
   * @returns Human-readable explanation in business terms
   */
  async interpretMetadataChange(
    metadata: unknown,
    type: 'Flow' | 'ValidationRule' | 'CustomField' | 'FormulaField',
    name: string,
    settings: OrgSettings
  ): Promise<string> {
    let prompt = '';
    
    if (type === 'Flow') {
      prompt = `You are a Salesforce Architect explaining a Flow to a Business Manager.

Flow Name: ${name}
Flow Metadata:
${JSON.stringify(metadata, null, 2)}

Please explain:
1. What business process does this Flow automate?
2. What are the main steps or decision points?
3. What triggers this Flow?
4. What actions does it perform?

Use clear, non-technical language that a business manager can understand. Keep it under 200 words.`;
    } else if (type === 'ValidationRule') {
      // Validation Rules are blockers - they prevent invalid data entry
      const metadataObj = metadata as { errorConditionFormula?: string };
      const formula = metadataObj.errorConditionFormula || (typeof metadata === 'string' ? metadata : JSON.stringify(metadata));
      prompt = `You are a Salesforce Administrator explaining a **Validation Rule** (a data blocker) to a Business Manager.

Rule Name: ${name}
Validation Formula: ${formula}

**Context:** This is a Validation Rule, which BLOCKS users from saving records that don't meet certain conditions.

Please explain:
1. What condition does this rule check?
2. When will it trigger (what will cause a validation error)?
3. What is the business purpose or intent?
4. What data scenarios will be blocked or allowed?

Use plain language that a non-technical admin can understand. Keep it under 200 words.`;
    } else if (type === 'FormulaField') {
      // Formula Fields are calculations - they compute values automatically
      const metadataObj = metadata as { formula?: string; label?: string; type?: string };
      prompt = `You are a Salesforce Administrator explaining a **Formula Field** (an automatic calculation) to a Business Manager.

Field Name: ${name}
Field Label: ${metadataObj.label || 'N/A'}
Field Type: ${metadataObj.type || 'N/A'}
${metadataObj.formula ? `Calculation Formula: ${metadataObj.formula}` : ''}

**Context:** This is a Formula Field, which AUTOMATICALLY CALCULATES a value based on other fields. It does not block data entry.

Please explain:
1. What does this field automatically calculate?
2. How is the calculation performed (what fields/values are used)?
3. How is this calculated value used in the business process?
4. What business value does this automation provide?

Use clear, non-technical language. Keep it under 150 words.`;
    } else if (type === 'CustomField') {
      const metadataObj = metadata as { formula?: string; label?: string; type?: string };
      prompt = `You are a Salesforce Administrator explaining a Custom Field to a Business Manager.

Field Name: ${name}
Field Label: ${metadataObj.label || 'N/A'}
Field Type: ${metadataObj.type || 'N/A'}
${metadataObj.formula ? `Formula: ${metadataObj.formula}` : ''}

Please explain:
1. What does this field store or calculate?
2. How is it used in the business process?
3. ${metadataObj.formula ? 'What does the formula calculate and why?' : 'What type of data does it contain?'}

Use clear, non-technical language. Keep it under 150 words.`;
    } else {
      prompt = `You are a Salesforce Architect explaining metadata changes to a Business Manager.

Item Name: ${name}
Type: ${type}
Metadata:
${JSON.stringify(metadata, null, 2)}

Please explain what this change means in business terms. Use clear, non-technical language. Keep it under 200 words.`;
    }

    try {
      return await this.callLLM(prompt, settings);
    } catch (error) {
      console.error(`Error interpreting ${type} metadata change:`, error);
      throw new Error(`Failed to interpret ${type} metadata: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Interpret an unmapped Salesforce audit trail action
   * Uses LLM to explain what the action means in business terms
   * 
   * DISABLED: This method was commented out because sending all unmapped actions to LLM
   * generated too many notifications. Only known action types are now processed.
   * 
   * @param action Salesforce action code (e.g., "PermSetAssign", "accountlayout")
   * @param display Human-readable description from audit trail
   * @param section Section where the change occurred
   * @param settings Org settings for billing mode
   * @returns Human-readable explanation
   */
  /*
  async interpretUnmappedAction(
    action: string,
    display: string,
    section: string,
    settings: OrgSettings
  ): Promise<string> {
    const prompt = `You are a Salesforce Administrator explaining an audit trail action to a Business Manager.

Action Code: ${action}
Description: ${display}
Section: ${section}

Please explain:
1. What type of change occurred (e.g., permission assignment, layout modification, metadata update)?
2. What does this action typically mean in Salesforce?
3. What is the business impact or purpose?
4. Should administrators be concerned about this change?

Use clear, non-technical language. Keep it under 150 words.`;

    try {
      return await this.callLLM(prompt, settings);
    } catch (error) {
      console.error(`Error interpreting unmapped action ${action}:`, error);
      return `This is a Salesforce audit trail action (${action}). The system could not generate an automated explanation. Please review manually: ${display}`;
    }
  }
  */

  /**
   * Sanitize JSON by removing visual noise elements
   * Strips locationX, locationY, connector, and processMetadataValues
   */
  private sanitizeJson(obj: unknown): unknown {
    if (obj === null || obj === undefined) {
      return obj;
    }

    if (Array.isArray(obj)) {
      return obj.map(item => this.sanitizeJson(item));
    }

    if (typeof obj === 'object') {
      const sanitized: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(obj)) {
        // Skip visual noise fields
        if (
          key === 'locationX' ||
          key === 'locationY' ||
          key === 'connector' ||
          key === 'processMetadataValues' ||
          key.toLowerCase().includes('location') ||
          key.toLowerCase().includes('connector')
        ) {
          continue;
        }
        sanitized[key] = this.sanitizeJson(value);
      }
      return sanitized;
    }

    return obj;
  }

  /**
   * Generate a summary of changes between two Flow versions
   * Updated to extract security findings from AI response
   */
  async generateSummary(
    oldJson: unknown,
    newJson: unknown,
    flowName: string,
    settings: OrgSettings,
    parentFlows?: Array<{ flowApiName: string; label?: string }>
  ): Promise<AuditDiff> {
    // Sanitize inputs to reduce token usage
    const sanitizedOld = this.sanitizeJson(oldJson);
    const sanitizedNew = this.sanitizeJson(newJson);

    const prompt = this.buildPrompt(sanitizedOld, sanitizedNew, flowName, parentFlows);
    const summary = await this.callLLM(prompt, settings);

    // Parse the summary to extract structured information
    const changes = this.extractChanges(summary);
    const securityFindings = this.extractSecurityFindings(summary);

    return {
      flowName,
      flowApiName: flowName, // Can be enhanced to extract actual API name
      oldVersion: (sanitizedOld as { VersionNumber?: number })?.VersionNumber || 0,
      newVersion: (sanitizedNew as { VersionNumber?: number })?.VersionNumber || 0,
      summary,
      changes,
      securityFindings, // Add security findings to the response
      timestamp: new Date().toISOString(),
      orgId: settings.orgId,
    };
  }

  /**
   * Extract security findings from LLM response
   * Looks for SECURITY & PERFORMANCE section
   */
  private extractSecurityFindings(summary: string): string[] {
    const findings: string[] = [];
    const lines = summary.split('\n');

    let inSecuritySection = false;
    for (const line of lines) {
      if (line.trim().startsWith('SECURITY & PERFORMANCE:') || 
          line.trim().startsWith('SECURITY AND PERFORMANCE:')) {
        inSecuritySection = true;
        // Extract the content after the colon
        const content = line.split(':').slice(1).join(':').trim();
        if (content && !content.startsWith('IMPACTS')) {
          findings.push(content);
        }
        continue;
      }
      if (inSecuritySection && line.trim().startsWith('IMPACTS:')) {
        break;
      }
      if (inSecuritySection && line.trim()) {
        // Collect all lines in the security section
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith('IMPACTS')) {
          findings.push(trimmed);
        }
      }
    }

    return findings.length > 0 ? findings : [];
  }

  /**
   * Build the prompt for the LLM
   * Updated to focus on security auditing and business impact
   * Includes parent flow information for subflow risk assessment
   */
  private buildPrompt(
    oldJson: unknown, 
    newJson: unknown, 
    flowName: string, 
    parentFlows?: Array<{ flowApiName: string; label?: string }>
  ): string {
    let parentFlowContext = '';
    if (parentFlows && parentFlows.length > 0) {
      const parentList = parentFlows.map(p => `- **${p.flowApiName}**${p.label ? ` (${p.label})` : ''}`).join('\n');
      parentFlowContext = `\n\n**⚠️ IMPORTANT CONTEXT:** This Flow is used as a SUBFLOW by the following parent Flow(s):\n${parentList}\n\n**Risk Assessment:** Changes to this subflow will affect all parent flows listed above. Consider the impact on parent flows when assessing risk level.`;
    }

    return `**System Role:** You are the "AuditDelta Guardian," an expert Salesforce Technical Architect and Security Auditor. Your task is to analyze changes between two versions of a Salesforce Flow and provide a "Bang" summary for a Slack notification.

**Instructions:**
1. **The Summary:** Start with one sentence explaining the "Why" of the change in business terms.
2. **The Logic Diff:** List exactly what elements were added, modified, or deleted. 
3. **Security & Performance (The Auditor's Eye):** Flag the following as 🔴 CRITICAL if found:
   - Hardcoded IDs (e.g., '005...' or '001...').
   - Database operations (Create/Update/Delete) inside a Loop.
   - Missing Fault Paths on critical DML elements.
4. **Subflow Impact:** ${parentFlows && parentFlows.length > 0 ? 'This Flow is a SUBFLOW used by parent flows. Changes here will cascade to parent flows. Assess risk accordingly.' : 'This Flow does not appear to be used as a subflow by other flows.'}
5. **Tone:** Be professional, concise, and focused on impact. Use bolding for element names.

**Constraint:** Output your response in Markdown suitable for Slack. Do not use technical jargon like 'JSON' or 'Metadata tags.'

Flow Name: **${flowName}**${parentFlowContext}

OLD VERSION:
${JSON.stringify(oldJson, null, 2)}

NEW VERSION:
${JSON.stringify(newJson, null, 2)}

Format your response as:
SUMMARY: [One sentence explaining the business reason for the change]

CHANGES:
- [change 1 - what element was added/modified/deleted]
- [change 2]
- [change 3]

SECURITY & PERFORMANCE:
[🔴 CRITICAL: List any security/performance issues found, or "✅ No critical issues detected"]

IMPACTS: [Any business impacts or concerns${parentFlows && parentFlows.length > 0 ? ', including impact on parent flows' : ''}]`;
  }

  /**
   * Call the LLM (Gemini or Vertex AI) based on billing mode
   */
  private async callLLM(prompt: string, settings: OrgSettings): Promise<string> {
    if (settings.billingMode === 'ENTERPRISE') {
      return this.callVertexAI(prompt, settings);
    } else {
      return this.callGeminiAPI(prompt);
    }
  }

  /**
   * Call Google Gemini API (Personal billing mode)
   * Made public for testing purposes
   */
  async callGeminiAPI(prompt: string): Promise<string> {
    if (!this.geminiApiKey) {
      throw new Error('GEMINI_API_KEY is not configured');
    }

    // Use gemini-2.5-flash (latest) or gemini-2.5-pro
    // gemini-1.5-flash and gemini-1.5-pro are no longer available
    const url = `https://generativelanguage.googleapis.com/v1/models/${this.geminiModel}:generateContent?key=${this.geminiApiKey}`;

    try {
      const response = await this.axiosInstance.post(
        url,
        {
          contents: [
            {
              parts: [
                {
                  text: prompt,
                },
              ],
            },
          ],
        },
        {
          headers: {
            'Content-Type': 'application/json',
          },
        }
      );

      const text = response.data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) {
        throw new Error('No response text from Gemini API');
      }

      return text;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        console.error('Gemini API Error:', error.response?.data || error.message);
        throw new Error(`Gemini API call failed: ${error.response?.status} ${error.message}`);
      }
      throw error;
    }
  }

  /**
   * Call Google Vertex AI (Enterprise billing mode)
   * Includes X-Goog-User-Project header for customer billing
   */
  private async callVertexAI(prompt: string, settings: OrgSettings): Promise<string> {
    if (!settings.gcpProjectId) {
      throw new Error('GCP Project ID is required for Enterprise billing mode');
    }

    const projectId = settings.gcpProjectId;
    const location = this.vertexAiRegion;
    // Use gemini-2.5-flash (latest) or gemini-2.5-pro
    // gemini-1.5-flash and gemini-1.5-pro are no longer available
    const model = this.geminiModel;
    const url = `${this.vertexAiEndpoint}/${projectId}/locations/${location}/publishers/google/models/${model}:generateContent`;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Goog-User-Project': projectId, // Critical: This header ensures customer billing
    };

    // Add Authorization header if using service account (optional enhancement)
    // For now, assuming OAuth token is passed via environment or service account key

    try {
      const response = await this.axiosInstance.post(
        url,
        {
          contents: [
            {
              parts: [
                {
                  text: prompt,
                },
              ],
            },
          ],
        },
        {
          headers,
        }
      );

      const text = response.data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) {
        throw new Error('No response text from Vertex AI');
      }

      return text;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        console.error('Vertex AI Error:', error.response?.data || error.message);
        throw new Error(`Vertex AI call failed: ${error.response?.status} ${error.message}`);
      }
      throw error;
    }
  }

  /**
   * Extract structured changes from LLM response
   */
  private extractChanges(summary: string): string[] {
    const changes: string[] = [];
    const lines = summary.split('\n');

    let inChangesSection = false;
    for (const line of lines) {
      if (line.trim().startsWith('CHANGES:')) {
        inChangesSection = true;
        continue;
      }
      if (inChangesSection && line.trim().startsWith('IMPACTS:')) {
        break;
      }
      if (inChangesSection && line.trim().startsWith('-')) {
        changes.push(line.trim().substring(1).trim());
      }
    }

    return changes.length > 0 ? changes : [summary]; // Fallback to full summary if parsing fails
  }
}

