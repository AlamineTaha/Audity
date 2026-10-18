import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { z } from 'zod';
import { authService, salesforceService, aiService, reportService } from '../services/container';
import { REPORTS_DIR } from '../config/reports';
import { AuditReportProcessType, AuditReportEntry, SetupAuditTrail } from '../types';
import { defineTool, fail, ok } from './types';

// Process-type matchers (mirrors MonitorService logic)
const PROCESS_MATCHERS: Record<string, (r: SetupAuditTrail) => boolean> = {
  Flow: (r) => {
    const a = (r.Action || '').toLowerCase();
    const s = (r.Section || '').toLowerCase();
    return a.includes('flow') || s.includes('flow');
  },
  Permission: (r) => {
    const a = (r.Action || '').toLowerCase();
    return (
      a.includes('perm') ||
      a.includes('profile') ||
      a.includes('role') ||
      a.includes('userrole')
    );
  },
  Layout: (r) => {
    const a = (r.Action || '').toLowerCase();
    const s = (r.Section || '').toLowerCase();
    return a.includes('layout') || s.includes('layout');
  },
  ValidationRule: (r) => {
    const a = (r.Action || '').toLowerCase();
    return a.includes('validation');
  },
  CustomField: (r) => {
    const a = (r.Action || '').toLowerCase();
    return a.includes('customfield') || a.includes('formula') || a.startsWith('changedcf') || a.startsWith('createdcf') || a.startsWith('deletedcf');
  },
  Object: (r) => {
    const a = (r.Action || '').toLowerCase();
    const s = (r.Section || '').toLowerCase();
    return (
      a.includes('entity') ||
      a.includes('customobject') ||
      s.startsWith('customize')
    );
  },
};

function classifyEntry(record: SetupAuditTrail): string {
  for (const [type, matcher] of Object.entries(PROCESS_MATCHERS)) {
    if (matcher(record)) return type;
  }
  return 'Other';
}

const VALID_TYPES: AuditReportProcessType[] = [
  'Flow', 'Permission', 'Layout', 'ValidationRule', 'CustomField', 'Object', 'All',
];
const HOURS_ERROR = 'hours must be an integer between 1 and 168';

export const generateAuditReportTool = defineTool({
  name: 'generate_audit_report',
  title: 'Generate Audit Report PDF',
  description:
    'Generates a downloadable PDF audit report of Setup Audit Trail changes for a metadata category over the last N ' +
    'hours (1-168), with an AI explanation of each change and an executive summary, and returns a download link. ' +
    'Use when the user asks for an audit report, compliance documentation, or a summary document of recent changes.',
  inputSchema: z.object({
    processType: z
      .enum(VALID_TYPES as [AuditReportProcessType, ...AuditReportProcessType[]], {
        error: `Invalid processType. Must be one of: ${VALID_TYPES.join(', ')}`,
      })
      .default('All')
      .describe('Category of metadata changes to include: Flow, Permission, Layout, ValidationRule, CustomField, Object, or All (default).'),
    hours: z.coerce
      .number({ error: HOURS_ERROR })
      .int(HOURS_ERROR)
      .min(1, HOURS_ERROR)
      .max(168, HOURS_ERROR)
      .default(24)
      .describe('Look-back window in hours (1-168). Default 24.'),
  }),
  async handler(ctx, { processType, hours }) {
    const orgId = ctx.tenant.orgId;
    try {
      const settings = await authService.getOrgSettings(orgId);
      if (!settings) {
        return fail(404, 'Organization settings not found. Please re-authenticate at /auth/authorize');
      }

      console.log(`[AuditReport] Generating report – org=${orgId} process=${processType} hours=${hours}`);

      const auditRecords = await salesforceService.queryAuditTrailByHours(orgId, hours);

      const filtered =
        processType === 'All'
          ? auditRecords
          : auditRecords.filter((r) => {
              const matcher = PROCESS_MATCHERS[processType];
              return matcher ? matcher(r) : false;
            });

      console.log(`[AuditReport] ${auditRecords.length} total records, ${filtered.length} match "${processType}"`);

      // Build report entries with AI explanations (batch with concurrency limit)
      const CONCURRENCY = 5;
      const entries: AuditReportEntry[] = [];

      for (let i = 0; i < filtered.length; i += CONCURRENCY) {
        const batch = filtered.slice(i, i + CONCURRENCY);
        const results = await Promise.all(
          batch.map(async (record): Promise<AuditReportEntry> => {
            let explanation: string | undefined;
            try {
              explanation = await aiService.interpretAuditEntry(
                record.Action,
                record.Display || '',
                record.Section || '',
                settings
              );
            } catch {
              explanation = undefined;
            }

            return {
              timestamp: record.CreatedDate,
              user: record.CreatedBy?.Name || 'Unknown',
              action: record.Action,
              display: record.Display || '',
              section: record.Section || '',
              processType: classifyEntry(record),
              explanation,
            };
          })
        );
        entries.push(...results);
      }

      const overallSummary = await aiService.generateAuditReportSummary(
        entries.map((e) => ({
          action: e.action,
          display: e.display,
          user: e.user,
          section: e.section,
          processType: e.processType,
        })),
        processType,
        hours,
        settings
      );

      const pdfBuffer = await reportService.generatePdf(entries, processType, hours, orgId, overallSummary);

      const reportId = crypto.randomUUID();
      const filename = `AuditDelta_${processType}_${hours}h_${reportId}.pdf`;
      const filePath = path.join(REPORTS_DIR, filename);
      fs.writeFileSync(filePath, pdfBuffer);

      const downloadUrl = `${ctx.baseUrl}/reports/${filename}`;

      console.log(`[AuditReport] Report saved: ${filePath} (${pdfBuffer.length} bytes)`);

      const displayText = `Your audit report is ready.\n\n` +
        `Type: ${processType} changes in the last ${hours} hour(s)\n` +
        `Records: ${filtered.length} change(s) analyzed\n\n` +
        `Download: ${downloadUrl}`;

      return ok({
        displayText,
        downloadUrl,
        filename,
        reportDetails: {
          processType,
          hours,
          totalRecords: auditRecords.length,
          filteredRecords: filtered.length,
          entriesAnalyzed: entries.length,
        },
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      console.error('Error in generate-audit-report endpoint:', error);
      const errorMessage = error instanceof Error ? error.message : 'Internal server error';
      return fail(500, errorMessage);
    }
  },
});

export const reportTools = [generateAuditReportTool];
