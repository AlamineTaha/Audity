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
   */
  async generateSummary(
    oldJson: unknown,
    newJson: unknown,
    flowName: string,
    settings: OrgSettings
  ): Promise<AuditDiff> {
    // Sanitize inputs to reduce token usage
    const sanitizedOld = this.sanitizeJson(oldJson);
    const sanitizedNew = this.sanitizeJson(newJson);

    const prompt = this.buildPrompt(sanitizedOld, sanitizedNew, flowName);
    const summary = await this.callLLM(prompt, settings);

    // Parse the summary to extract structured information
    const changes = this.extractChanges(summary);

    return {
      flowName,
      flowApiName: flowName, // Can be enhanced to extract actual API name
      oldVersion: (sanitizedOld as { VersionNumber?: number })?.VersionNumber || 0,
      newVersion: (sanitizedNew as { VersionNumber?: number })?.VersionNumber || 0,
      summary,
      changes,
      timestamp: new Date().toISOString(),
      orgId: settings.orgId,
    };
  }

  /**
   * Build the prompt for the LLM
   */
  private buildPrompt(oldJson: unknown, newJson: unknown, flowName: string): string {
    return `You are an expert Salesforce Flow analyst. Analyze the differences between two versions of a Salesforce Flow and provide a clear, concise summary.

Flow Name: ${flowName}

OLD VERSION:
${JSON.stringify(oldJson, null, 2)}

NEW VERSION:
${JSON.stringify(newJson, null, 2)}

Please provide:
1. A high-level summary of what changed (2-3 sentences)
2. A bulleted list of specific changes (e.g., "Added new decision element", "Modified field update logic", "Removed unused variable")
3. Any potential impacts or concerns

Format your response as:
SUMMARY: [your summary here]
CHANGES:
- [change 1]
- [change 2]
- [change 3]
IMPACTS: [any concerns or impacts]`;
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

