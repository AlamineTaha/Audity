/**
 * AI Service for analyzing Flow and CMS changes
 * Supports both Personal (Gemini API Key) and Enterprise (Vertex AI) billing modes
 */

import axios, { AxiosInstance } from 'axios';
import { OrgSettings, AuditDiff } from '../types';
import { logLLMCall } from '../utils/llmPromptLogger';

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
      return await this.callLLM(prompt, settings, 'interpretValidationFormula');
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
      return await this.callLLM(prompt, settings, 'compareValidationRuleFormulas');
    } catch (error) {
      console.error('Error comparing validation rule formulas:', error);
      throw new Error(`Failed to compare validation rule formulas: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Analyze a validation rule in the context of all validation rules on the same object.
   * Explains the rule, infers change impact from the action, and assesses object health.
   */
  async analyzeValidationRuleInContext(
    ruleName: string,
    formula: string,
    errorMessage: string,
    action: string,
    objectName: string,
    allRulesOnObject: Array<{ name: string; active: boolean }>,
    settings: OrgSettings
  ): Promise<string> {
    const activeCount = allRulesOnObject.filter(r => r.active).length;

    const prompt = `Analyze this Salesforce validation rule for a Slack message. Be direct, no fluff.

Rule: \`${ruleName}\` on \`${objectName}\`
Action: ${action}
Formula: \`\`\`${formula}\`\`\`
Error Message shown to users: "${errorMessage || '(none)'}"

Rules: No emoji. No HTML entities. Slack markdown only (*bold*, \`code\`). Under 100 words.

Answer EXACTLY:

*What it does:* [One sentence — what the formula blocks or enforces]

*Impact:* [One sentence — which users or processes are affected]

*Naming & Error Message:* [Flag if the rule name is unclear/misleading, or if the error message is vague/missing/unhelpful to end users. Say "OK" if both are fine.]

*Object Health:* ${activeCount} active rules on \`${objectName}\` (${allRulesOnObject.length} total). [If >10 active, say "Review recommended." Otherwise "OK."]`;

    try {
      return await this.callLLM(prompt, settings, 'analyzeValidationRuleInContext');
    } catch (error) {
      console.error('Error analyzing validation rule in context:', error);
      throw new Error(`Failed to analyze validation rule: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Analyze a formula field change concisely.
   */
  async analyzeFormulaField(
    fieldName: string,
    objectName: string,
    formula: string | undefined,
    label: string | undefined,
    settings: OrgSettings
  ): Promise<string> {
    const prompt = `You are the "AuditDelta Guardian," an expert Salesforce Auditor. Analyze this formula field for a Slack notification.

Object: \`${objectName}\`
Field: \`${fieldName}\`
Label: ${label || 'N/A'}
${formula ? `Formula:\n\`\`\`\n${formula}\n\`\`\`` : 'Formula: not available'}

Rules:
- Do NOT use any emoji, HTML entities, or special Unicode characters.
- Use Slack markdown only: *bold*, _italic_, \`code\` for names.
- Be concise. Under 150 words total.

Format your response EXACTLY as:

*Summary:* [One sentence — what this formula field calculates and why it matters]

*Impact:* [One sentence — how this affects reports, workflows, or user experience]`;

    try {
      return await this.callLLM(prompt, settings, 'analyzeFormulaField');
    } catch (error) {
      console.error('Error analyzing formula field:', error);
      throw new Error(`Failed to analyze formula field: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Analyze all validation rules for an object: health summary, grouping by functional area,
   * and suggestions for vague error messages.
   */
  async analyzeValidationRulesForObject(
    objectApiName: string,
    rules: Array<{
      id: string;
      validationName: string;
      active: boolean;
      description: string | null;
      errorMessage: string | null;
      objectApiName: string;
    }>,
    settings: OrgSettings
  ): Promise<{
    summary: string;
    categories: Array<{ name: string; rules: Array<{ validationName: string; active: boolean; errorMessage: string | null }> }>;
    vagueErrorSuggestions: Array<{ ruleName: string; currentMessage: string; suggestedMessage: string }>;
  }> {
    const rulesJson = JSON.stringify(
      rules.map(r => ({
        validationName: r.validationName,
        active: r.active,
        description: r.description,
        errorMessage: r.errorMessage,
      })),
      null,
      2
    );

    const prompt = `You are a Salesforce Technical Architect performing a Validation Rule audit.

Object: ${objectApiName}
Validation Rules (${rules.length} total, ${rules.filter(r => r.active).length} active):

${rulesJson}

Analyze and respond with a valid JSON object only. No markdown, no code fences, no extra text.

Required structure:
{
  "summary": "2-4 sentences summarizing the overall Validation Health of this object. Include: total/active count, any concerns (e.g. too many rules, redundancy), and overall assessment.",
  "categories": [
    {
      "name": "Functional area name (e.g. Address Validation, Revenue Requirements, Data Quality)",
      "rules": [
        { "validationName": "rule API name", "active": true/false, "errorMessage": "current message or null" }
      ]
    }
  ],
  "vagueErrorSuggestions": [
    {
      "ruleName": "rule API name",
      "currentMessage": "the vague or unhelpful current message",
      "suggestedMessage": "a clearer, user-friendly replacement"
    }
  ]
}

Rules:
- Group rules by inferred functional area based on name, description, and error message.
- Include ALL rules in categories (each rule in exactly one category).
- For vagueErrorSuggestions: flag rules with generic messages like "Error", "Invalid", "Please fix", empty messages, or messages that don't explain what to fix. Suggest specific, actionable messages.
- If no vague messages, return empty array for vagueErrorSuggestions.`;

    try {
      const raw = await this.callLLM(prompt, settings, 'analyzeValidationRulesForObject');
      const cleaned = raw.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
      const parsed = JSON.parse(cleaned) as {
        summary?: string;
        categories?: Array<{ name: string; rules: Array<{ validationName: string; active: boolean; errorMessage: string | null }> }>;
        vagueErrorSuggestions?: Array<{ ruleName: string; currentMessage: string; suggestedMessage: string }>;
      };

      return {
        summary: parsed.summary || 'No summary generated.',
        categories: parsed.categories || [],
        vagueErrorSuggestions: parsed.vagueErrorSuggestions || [],
      };
    } catch (error) {
      console.error('Error analyzing validation rules:', error);
      throw new Error(`Failed to analyze validation rules: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Analyze a Permission Set's security posture: what it grants, risks, and best-practice violations.
   */
  async analyzePermissionSet(
    permissionSet: {
      name: string;
      label: string;
      isOwnedByProfile: boolean;
      profileName: string | null;
      description: string | null;
      license: string | null;
      objectPermissions: Array<{
        objectName: string;
        canCreate: boolean;
        canRead: boolean;
        canEdit: boolean;
        canDelete: boolean;
        viewAllRecords: boolean;
        modifyAllRecords: boolean;
      }>;
      systemPermissions: string[];
      assignedUserCount: number;
    },
    settings: OrgSettings
  ): Promise<{
    summary: string;
    objectAccess: Array<{
      objectName: string;
      accessLevel: string;
      permissions: string[];
    }>;
    systemPermissions: string[];
    risks: Array<{
      severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
      description: string;
      recommendation: string;
    }>;
    overallRiskLevel: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
  }> {
    const objectPermsJson = JSON.stringify(permissionSet.objectPermissions, null, 2);
    const sysPerms = permissionSet.systemPermissions.length > 0
      ? permissionSet.systemPermissions.join(', ')
      : 'None';

    const typeLabel = permissionSet.isOwnedByProfile
      ? `Profile: ${permissionSet.profileName || permissionSet.name}`
      : `Permission Set: ${permissionSet.label}`;

    const prompt = `You are an expert Salesforce Security Architect performing a Permission Set audit.

${typeLabel}
${permissionSet.description ? `Description: ${permissionSet.description}` : ''}
${permissionSet.license ? `License: ${permissionSet.license}` : ''}
Assigned to ${permissionSet.assignedUserCount} user(s).

OBJECT PERMISSIONS (${permissionSet.objectPermissions.length} objects):
${objectPermsJson}

SYSTEM PERMISSIONS:
${sysPerms}

Analyze and respond with a valid JSON object only. No markdown, no code fences, no extra text.

Required structure:
{
  "summary": "3-5 sentences summarizing what this permission set grants, its purpose, scope, and overall security posture.",
  "objectAccess": [
    {
      "objectName": "Account",
      "accessLevel": "Full Access / Read-Write / Read Only / Limited",
      "permissions": ["Create", "Read", "Edit", "Delete", "ViewAll", "ModifyAll"]
    }
  ],
  "systemPermissions": ["list of enabled system permissions with brief explanation of each"],
  "risks": [
    {
      "severity": "CRITICAL | HIGH | MEDIUM | LOW",
      "description": "Clear description of the risk",
      "recommendation": "Actionable recommendation to mitigate"
    }
  ],
  "overallRiskLevel": "CRITICAL | HIGH | MEDIUM | LOW"
}

Rules:
- objectAccess: list EVERY object with its effective access level and granted permissions.
- systemPermissions: for each enabled system permission, provide a one-line explanation of what it allows.
- risks: identify ALL security concerns. Examples of what to flag:
  - CRITICAL: ModifyAllData, ViewAllData, ModifyAllRecords on sensitive objects (Opportunity, Contact, Lead, Account, Case), ManageUsers, CustomizeApplication, AuthorApex.
  - HIGH: Delete on production objects, BulkApiHardDelete, ExportReport on sensitive data, ManageProfilesPermissionsets.
  - MEDIUM: Broad Edit access across many objects, ViewAllRecords on sensitive objects.
  - LOW: Minor best-practice deviations.
- overallRiskLevel: the highest severity found in risks. If no risks, use LOW.
- If this is a Profile (IsOwnedByProfile=true), note that it grants a baseline set of permissions to all users with that profile.`;

    try {
      const raw = await this.callLLM(prompt, settings, 'analyzePermissionSet');
      const cleaned = raw.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
      const parsed = JSON.parse(cleaned) as {
        summary?: string;
        objectAccess?: Array<{ objectName: string; accessLevel: string; permissions: string[] }>;
        systemPermissions?: string[];
        risks?: Array<{ severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW'; description: string; recommendation: string }>;
        overallRiskLevel?: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
      };

      return {
        summary: parsed.summary || 'No summary generated.',
        objectAccess: parsed.objectAccess || [],
        systemPermissions: parsed.systemPermissions || [],
        risks: parsed.risks || [],
        overallRiskLevel: parsed.overallRiskLevel || 'LOW',
      };
    } catch (error) {
      console.error('Error analyzing permission set:', error);
      throw new Error(`Failed to analyze permission set: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Analyze a batch of permission changes from the same user.
   * All permission types (PermSetAssign, PermSetEnableUserPerm, PermSetEntityPermChanged, etc.)
   * are sent in one call. Output follows the same concise format as Flow summaries.
   */
  async analyzePermissionBatch(
    changes: Array<{ action: string; display: string }>,
    userName: string,
    settings: OrgSettings
  ): Promise<string> {
    const changesList = changes
      .map((c, i) => `${i + 1}. [${c.action}] ${c.display}`)
      .join('\n');

    const prompt = `You are the "AuditDelta Guardian," an expert Salesforce Security Auditor. Analyze these permission changes for a Slack notification.

The admin "${userName}" made ${changes.length} permission change(s):

${changesList}

Rules:
- Do NOT use any emoji, HTML entities, or special Unicode characters.
- Use Slack markdown only: *bold*, _italic_, \`code\` for names.
- Be concise. Under 200 words total.

Format your response EXACTLY as:

*Summary:* [One sentence — what was changed and on which Permission Set]

*Changes:*
- [change 1 — what permission/object access was granted or revoked]
- [change 2]

*Security:*
- [CRITICAL] or [MEDIUM] or [LOW]: [one-sentence justification]

*Impact:* [Who is affected and what can they now do or no longer do]`;

    try {
      return await this.callLLM(prompt, settings, 'analyzePermissionBatch');
    } catch (error) {
      console.error('Error analyzing permission batch:', error);
      throw new Error(`Failed to analyze permission batch: ${error instanceof Error ? error.message : 'Unknown error'}`);
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
      return await this.callLLM(prompt, settings, `interpretMetadataChange:${type}`);
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
   * Generate an executive summary and per-entry explanations for an Audit Report.
   * Returns the overall summary string; individual entries get their explanation
   * via interpretAuditEntry (called separately per row).
   */
  async generateAuditReportSummary(
    entries: Array<{ action: string; display: string; user: string; section: string; processType: string }>,
    processType: string,
    hours: number,
    settings: OrgSettings
  ): Promise<string> {
    const entriesList = entries
      .slice(0, 40) // cap to avoid huge prompts
      .map((e, i) => `${i + 1}. [${e.processType}] ${e.action} by ${e.user} — ${e.display}`)
      .join('\n');

    const prompt = `You are the AuditDelta Guardian, an expert Salesforce Auditor writing an executive summary for a PDF report.

Process Type Filter: ${processType}
Time Window: Last ${hours} hour(s)
Total Changes: ${entries.length}

Changes:
${entriesList}

Write a concise executive summary (3-5 sentences) for stakeholders:
1. Highlight the most significant changes and their business impact.
2. Flag any security or compliance concerns.
3. Note patterns (e.g., bulk changes by one user, high-risk permission changes).
4. End with an overall risk assessment (Low / Medium / High).

Rules:
- Plain text only. No markdown, no bullets, no emoji.
- Under 200 words.`;

    try {
      return await this.callLLM(prompt, settings, 'generateAuditReportSummary');
    } catch (error) {
      console.error('Error generating audit report summary:', error);
      return `${entries.length} change(s) detected in the last ${hours} hour(s) for ${processType}. Please review the details below.`;
    }
  }

  /**
   * Interpret a single SetupAuditTrail entry for the PDF report.
   * Lighter-weight than full metadata analysis — works from the Display string alone.
   */
  async interpretAuditEntry(
    action: string,
    display: string,
    section: string,
    settings: OrgSettings
  ): Promise<string> {
    const prompt = `You are a Salesforce auditor explaining a Setup Audit Trail entry to a business manager.

Action: ${action}
Description: ${display}
Section: ${section}

In 1-2 sentences, explain what this change means in business terms and whether it poses any risk.
Plain text only. No markdown, no emoji. Under 60 words.`;

    try {
      return await this.callLLM(prompt, settings, 'interpretAuditEntry');
    } catch (error) {
      console.error(`Error interpreting audit entry ${action}:`, error);
      return `Change recorded: ${display}`;
    }
  }

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
    const summary = await this.callLLM(prompt, settings, 'generateSummary');

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
   * Generate an aggregate summary for a development session
   * Alias for analyzeDevelopmentSession - used when active_session expires
   */
  async generateAggregateSummary(
    changes: Array<{ version?: number; summary: string; timestamp: string; action: string }>,
    metadataName: string,
    metadataType: string,
    settings: OrgSettings
  ): Promise<string> {
    return this.analyzeDevelopmentSession(changes, metadataName, metadataType, settings);
  }

  /**
   * Analyze a development session with multiple changes
   * Summarizes all changes in a session to identify patterns, fixes, and final state
   * 
   * @param changes Array of change objects with version numbers and summaries
   * @param metadataName Name of the metadata item (e.g., Flow name, Validation Rule name)
   * @param metadataType Type of metadata (e.g., 'FlowDefinition', 'ValidationRule')
   * @param settings Org settings for billing mode
   * @returns Session summary with insights about the development pattern
   */
  async analyzeDevelopmentSession(
    changes: Array<{
      version?: number;
      summary: string;
      timestamp: string;
      action: string;
    }>,
    metadataName: string,
    metadataType: string,
    settings: OrgSettings
  ): Promise<string> {
    const changesText = changes.map((change, index) => {
      return `Change ${index + 1} (Version ${change.version || 'N/A'}, ${change.timestamp}):
Action: ${change.action}
Summary: ${change.summary}
---`;
    }).join('\n\n');

    const prompt = `You are a Salesforce Development Session Analyzer. Analyze this development session for ${metadataType} "${metadataName}".

The developer made ${changes.length} change(s) in a short time period:

${changesText}

Please provide a comprehensive session summary:
1. *Starting State:* What was the initial state or goal?
2. *Development Pattern:* Did the developer iterate to fix issues? Were there any bugs introduced and then fixed?
3. *Final State:* What is the final, active state after all changes?
4. *Insights:* Any patterns or concerns (e.g., multiple rapid changes suggesting troubleshooting, or a clean progression)?

Format your response in clear sections. Use Slack markdown formatting (*bold* for emphasis). Keep it concise but informative (under 300 words).`;

    try {
      return await this.callLLM(prompt, settings);
    } catch (error) {
      console.error(`Error analyzing development session:`, error);
      return `Session Summary: ${changes.length} change(s) were made to ${metadataName}. Review the individual changes for details.`;
    }
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
      const parentList = parentFlows.map(p => `- ${p.flowApiName}${p.label ? ` (${p.label})` : ''}`).join('\n');
      parentFlowContext = `\n\nIMPORTANT: This Flow is used as a subflow by:\n${parentList}\nChanges here affect all parent flows above.`;
    }

    return `You are an expert Salesforce Technical Architect. Compare two Flow versions and explain what changed.

Flow: ${flowName}${parentFlowContext}

OLD VERSION:
${JSON.stringify(oldJson, null, 2)}

NEW VERSION:
${JSON.stringify(newJson, null, 2)}

Rules:
- Plain text only. No markdown, no stars, no backticks, no quotes, no emoji, no HTML.
- Be concise. Under 200 words.
- Flag: hardcoded IDs, DML inside loops, missing fault paths.

Format your response EXACTLY as:

Summary: [One sentence — the business reason for this change]

Changes:
- [change 1 — element name, what was added/modified/deleted]
- [change 2]

Security:
- [CRITICAL or MEDIUM or LOW]: [description]. Or "No issues detected."

Impact: [One sentence — who or what is affected]`;
  }

  /**
   * Analyze a single flow version (no comparison).
   */
  async analyzeFlowVersion(
    metadata: unknown,
    flowName: string,
    version: number,
    settings: OrgSettings
  ): Promise<string> {
    const sanitized = this.sanitizeJson(metadata);

    const prompt = `You are an expert Salesforce Technical Architect. Analyze this Flow and explain what it does.

Flow: ${flowName} (Version ${version})

FLOW METADATA:
${JSON.stringify(sanitized, null, 2)}

Rules:
- Plain text only. No markdown, no stars, no backticks, no quotes, no emoji, no HTML.
- Be concise. Under 200 words.
- Flag: hardcoded IDs, DML inside loops, missing fault paths.

Format your response EXACTLY as:

Purpose: [One sentence — what this flow does and when it runs]

How it works:
- [step 1 — element name, what it does]
- [step 2]
- [step 3]

Security:
- [CRITICAL or MEDIUM or LOW]: [description]. Or "No issues detected."

Impact: [One sentence — which users, objects, or processes are affected]`;

    return await this.callLLM(prompt, settings, 'analyzeFlowVersion');
  }

  /**
   * Call the LLM (Gemini or Vertex AI) based on billing mode
   * Logs prompt and response to llm_prompts_log.jsonl for debugging duplicate messages
   */
  private async callLLM(prompt: string, settings: OrgSettings, method: string = 'unknown'): Promise<string> {
    const raw = settings.billingMode === 'ENTERPRISE'
      ? await this.callVertexAI(prompt, settings)
      : await this.callGeminiAPI(prompt);

    const response = this.decodeHtmlEntities(raw);

    logLLMCall({
      timestamp: new Date().toISOString(),
      method,
      context: `${method} | orgId=${settings.orgId}`,
      prompt,
      response,
      promptLength: prompt.length,
      responseLength: response.length,
    });

    return response;
  }

  /**
   * Decode HTML entities that the LLM sometimes emits
   * (e.g. &#128308; → 🔴, &quot; → ", &#39; → ')
   */
  private decodeHtmlEntities(text: string): string {
    const named: Record<string, string> = {
      '&amp;': '&', '&lt;': '<', '&gt;': '>',
      '&quot;': '"', '&apos;': "'", '&#39;': "'",
      '&nbsp;': ' ',
    };
    let result = text;
    for (const [entity, char] of Object.entries(named)) {
      result = result.split(entity).join(char);
    }
    result = result.replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)));
    result = result.replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)));
    return result;
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

