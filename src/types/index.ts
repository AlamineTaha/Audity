/**
 * Type definitions for AuditDelta application
 */

import { Request } from 'express';

/**
 * Organization settings including authentication and billing configuration
 */
export interface OrgSettings {
  orgId: string;
  accessToken: string;
  refreshToken: string;
  instanceUrl: string;
  billingMode: 'PERSONAL' | 'ENTERPRISE';
  gcpProjectId?: string;
}

/**
 * Tenant context resolved by the tenantAuth middleware.
 * Attached to every authenticated request as `req.tenant`.
 */
export interface TenantContext {
  orgId: string;
  instanceUrl: string;
  billingMode: 'PERSONAL' | 'ENTERPRISE';
  gcpProjectId?: string;
}

/**
 * Express Request augmented with tenant context.
 */
export interface AuthenticatedRequest extends Request {
  tenant: TenantContext;
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
  securityFindings?: string[];
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
  revertOptions?: {
    summary: string;
    versionsToday: number[];
    recommendedStableVersion: number | null;
    revertPrompt: string;
  };
  riskAnalysis?: { riskLevel: string; riskReason: string };
  revertImpact?: { warnings: string[]; activeSessions: number; canRevert: boolean };
  dependencies?: {
    reportedDependencies: Array<{
      type: string;
      name: string;
      description?: string;
    }>;
    uiDependencies: {
      buttons: Array<{
        name: string;
        label: string;
        linkType: string;
        objectType?: string;
      }>;
      quickActions: Array<{
        actionTarget: string;
        label: string;
        targetObject?: string;
      }>;
    };
    subflowDependencies: Array<{
      flowApiName: string;
      elementLabel?: string;
    }>;
    securityNote: string;
  };
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

/**
 * Change notification payload for Slack
 */
export interface ChangeNotification {
  type: 'Flow' | 'Permission' | 'Object' | string;
  changeType: string;
  user: string;
  timestamp: string;
  orgId: string;
  summary: string;
  changes: string[];
  riskLevel: 'Low' | 'Medium' | 'High';
  salesforceUrl: string;
}

/**
 * Supported process types for the Audit Report endpoint
 */
export type AuditReportProcessType =
  | 'Flow'
  | 'Permission'
  | 'Layout'
  | 'ValidationRule'
  | 'CustomField'
  | 'Object'
  | 'All';

/**
 * A single row in the generated Audit Report
 */
export interface AuditReportEntry {
  timestamp: string;
  user: string;
  action: string;
  display: string;
  section: string;
  processType: string;
  explanation?: string;
}

/**
 * Request payload for the generate-audit-report endpoint
 */
export interface GenerateAuditReportRequest {
  processType: AuditReportProcessType;
  hours: number;
}

/**
 * Response payload for the generate-audit-report endpoint
 */
export interface GenerateAuditReportResponse {
  success: boolean;
  reportTitle: string;
  processType: AuditReportProcessType;
  timeWindowHours: number;
  totalChanges: number;
  generatedAt: string;
  error?: string;
}