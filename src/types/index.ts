/**
 * Type definitions for AuditDelta application
 */

/**
 * Organization settings including authentication and billing configuration
 */
export interface OrgSettings {
  orgId: string;
  accessToken: string;
  refreshToken: string;
  instanceUrl: string;
  billingMode: 'PERSONAL' | 'ENTERPRISE';
  gcpProjectId?: string; // Required when billingMode === 'ENTERPRISE'
}

/**
 * Flow Metadata response from Salesforce Tooling API
 */
export interface FlowMetadata {
  Id: string;
  ApiName: string;
  Label: string;
  VersionNumber: number;
  LatestVersionId?: string;
  Status: string;
  Definition?: FlowDefinition;
  [key: string]: unknown; // Allow additional Salesforce fields
}

/**
 * Flow Definition structure (simplified representation)
 */
export interface FlowDefinition {
  startElementReference?: string;
  nodes?: FlowNode[];
  processMetadataValues?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Flow Node structure
 */
export interface FlowNode {
  apiName: string;
  label: string;
  locationX?: number;
  locationY?: number;
  connector?: unknown;
  [key: string]: unknown;
}

/**
 * Setup Audit Trail record from Salesforce
 */
export interface SetupAuditTrail {
  Id: string;
  Action: string;
  Display: string;
  CreatedDate: string;
  CreatedBy: {
    Id: string;
    Name: string;
  };
  Section: string;
  DelegateUser?: {
    Id: string;
    Name: string;
  };
  [key: string]: unknown;
}

/**
 * Audit difference result from AI analysis
 */
export interface AuditDiff {
  flowName: string;
  flowApiName: string;
  oldVersion: number;
  newVersion: number;
  summary: string;
  changes: string[];
  timestamp: string;
  orgId: string;
}

/**
 * Managed Content metadata from Salesforce Connect API
 */
export interface ManagedContent {
  id: string;
  title: string;
  urlName: string;
  language: string;
  contentBody?: string;
  [key: string]: unknown;
}

/**
 * Request payload for Agentforce API
 */
export interface AnalyzeFlowRequest {
  flowName: string;
  orgId: string;
}

/**
 * Response payload for Agentforce API
 */
export interface AnalyzeFlowResponse {
  success: boolean;
  flowName: string;
  summary: string;
  changes?: string[];
  error?: string;
}

/**
 * Slack notification payload
 */
export interface SlackNotification {
  flowName: string;
  summary: string;
  changes: string[];
  orgId: string;
  timestamp: string;
}

