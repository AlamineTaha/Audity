/**
 * Report Service
 * Generates PDF audit reports from SetupAuditTrail data with LLM explanations.
 * Used by the generate-audit-report Agentforce endpoint.
 */

import PDFDocument from 'pdfkit';
import { AuditReportEntry, AuditReportProcessType } from '../types';

const COLORS = {
  primary: '#1B5E94',
  accent: '#0D9DDB',
  headerBg: '#F0F7FC',
  rowAlt: '#F8FAFB',
  border: '#D0D5DD',
  text: '#1A1A1A',
  muted: '#667085',
  white: '#FFFFFF',
  risk: {
    low: '#12B76A',
    medium: '#F79009',
    high: '#F04438',
    critical: '#B42318',
  },
};

export class ReportService {
  /**
   * Build a PDF buffer from audit report data.
   * Returns a Buffer containing the complete PDF.
   */
  async generatePdf(
    entries: AuditReportEntry[],
    processType: AuditReportProcessType,
    hours: number,
    orgId: string,
    overallSummary: string
  ): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({
        size: 'A4',
        margins: { top: 50, bottom: 50, left: 50, right: 50 },
        bufferPages: true,
        info: {
          Title: `AuditDelta Report – ${processType}`,
          Author: 'AuditDelta Guardian',
          Subject: `Setup Audit Trail Report (${hours}h)`,
        },
      });

      const chunks: Buffer[] = [];
      doc.on('data', (chunk: Buffer) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      this.renderCoverSection(doc, processType, hours, orgId, entries.length);
      this.renderSummarySection(doc, overallSummary);
      this.renderEntriesSection(doc, entries);
      this.renderFooter(doc);

      doc.end();
    });
  }

  private renderCoverSection(
    doc: PDFKit.PDFDocument,
    processType: AuditReportProcessType,
    hours: number,
    orgId: string,
    totalChanges: number
  ): void {
    const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;

    doc.rect(doc.page.margins.left, doc.y, pageWidth, 90)
      .fill(COLORS.primary);

    doc.fillColor(COLORS.white)
      .font('Helvetica-Bold')
      .fontSize(24)
      .text('AuditDelta', doc.page.margins.left + 20, doc.y - 75, { continued: true })
      .font('Helvetica')
      .text(' Audit Report');

    doc.fillColor(COLORS.white)
      .font('Helvetica')
      .fontSize(11)
      .text('AI-Powered Setup Audit Trail Analysis', doc.page.margins.left + 20);

    doc.moveDown(2);

    const metaY = doc.y + 10;
    const col1X = doc.page.margins.left;
    const col2X = doc.page.margins.left + pageWidth / 2;
    const labelOpts = { width: pageWidth / 2 - 10 };

    doc.fillColor(COLORS.muted).font('Helvetica').fontSize(9);
    doc.text('Process Type', col1X, metaY, labelOpts);
    doc.text('Time Window', col2X, metaY, labelOpts);
    doc.fillColor(COLORS.text).font('Helvetica-Bold').fontSize(11);
    doc.text(processType, col1X, metaY + 13, labelOpts);
    doc.text(`Last ${hours} hour(s)`, col2X, metaY + 13, labelOpts);

    doc.fillColor(COLORS.muted).font('Helvetica').fontSize(9);
    doc.text('Organization', col1X, metaY + 35, labelOpts);
    doc.text('Total Changes', col2X, metaY + 35, labelOpts);
    doc.fillColor(COLORS.text).font('Helvetica-Bold').fontSize(11);
    doc.text(orgId, col1X, metaY + 48, labelOpts);
    doc.text(String(totalChanges), col2X, metaY + 48, labelOpts);

    doc.fillColor(COLORS.muted).font('Helvetica').fontSize(9);
    doc.text('Generated', col1X, metaY + 70, labelOpts);
    doc.fillColor(COLORS.text).font('Helvetica').fontSize(10);
    doc.text(new Date().toLocaleString('en-US', { dateStyle: 'full', timeStyle: 'long' }), col1X, metaY + 83, labelOpts);

    doc.y = metaY + 110;

    doc.moveTo(col1X, doc.y)
      .lineTo(col1X + pageWidth, doc.y)
      .strokeColor(COLORS.border)
      .lineWidth(0.5)
      .stroke();

    doc.moveDown(1);
  }

  private renderSummarySection(doc: PDFKit.PDFDocument, summary: string): void {
    const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const x = doc.page.margins.left;

    doc.fillColor(COLORS.primary).font('Helvetica-Bold').fontSize(14)
      .text('Executive Summary', x);
    doc.moveDown(0.5);

    const boxY = doc.y;
    const summaryHeight = doc.heightOfString(summary, { width: pageWidth - 30 }) + 20;
    doc.rect(x, boxY, pageWidth, summaryHeight + 10)
      .fill(COLORS.headerBg);

    doc.fillColor(COLORS.text).font('Helvetica').fontSize(10)
      .text(summary, x + 15, boxY + 10, { width: pageWidth - 30 });

    doc.y = boxY + summaryHeight + 20;
    doc.moveDown(0.5);
  }

  private renderEntriesSection(doc: PDFKit.PDFDocument, entries: AuditReportEntry[]): void {
    const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const x = doc.page.margins.left;

    doc.fillColor(COLORS.primary).font('Helvetica-Bold').fontSize(14)
      .text('Change Details', x);
    doc.moveDown(0.5);

    if (entries.length === 0) {
      doc.fillColor(COLORS.muted).font('Helvetica-Oblique').fontSize(10)
        .text('No changes found for the selected process type and time window.', x);
      return;
    }

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      this.renderEntryCard(doc, entry, i, pageWidth, x);
    }
  }

  private renderEntryCard(
    doc: PDFKit.PDFDocument,
    entry: AuditReportEntry,
    index: number,
    pageWidth: number,
    x: number
  ): void {
    doc.font('Helvetica').fontSize(9.5);
    const explanationHeight = entry.explanation
      ? doc.heightOfString(entry.explanation, { width: pageWidth - 30 })
      : 0;
    const cardHeight = 70 + (entry.explanation ? explanationHeight + 30 : 0);

    if (doc.y + cardHeight > doc.page.height - doc.page.margins.bottom - 30) {
      doc.addPage();
    }

    const cardY = doc.y;
    const bgColor = index % 2 === 0 ? COLORS.white : COLORS.rowAlt;
    doc.rect(x, cardY, pageWidth, cardHeight).fill(bgColor);

    doc.rect(x, cardY, 3, cardHeight).fill(COLORS.accent);

    const innerX = x + 12;
    const innerWidth = pageWidth - 22;

    doc.fillColor(COLORS.muted).font('Helvetica').fontSize(8)
      .text(
        `#${index + 1}  |  ${this.formatTimestamp(entry.timestamp)}  |  ${entry.user}  |  ${entry.processType}`,
        innerX, cardY + 8, { width: innerWidth }
      );

    doc.fillColor(COLORS.text).font('Helvetica-Bold').fontSize(10)
      .text(entry.action, innerX, cardY + 22, { width: innerWidth });

    doc.fillColor(COLORS.text).font('Helvetica').fontSize(9)
      .text(entry.display, innerX, cardY + 38, { width: innerWidth });

    if (entry.explanation) {
      const explY = cardY + 58;

      doc.rect(innerX, explY, innerWidth, explanationHeight + 16)
        .fill(COLORS.headerBg);

      doc.fillColor(COLORS.primary).font('Helvetica-Bold').fontSize(8)
        .text('AI Explanation', innerX + 8, explY + 4);

      doc.fillColor(COLORS.text).font('Helvetica').fontSize(9.5)
        .text(entry.explanation, innerX + 8, explY + 16, { width: innerWidth - 16 });
    }

    doc.y = cardY + cardHeight + 4;
  }

  private renderFooter(doc: PDFKit.PDFDocument): void {
    const pages = doc.bufferedPageRange();
    for (let i = 0; i < pages.count; i++) {
      doc.switchToPage(i);
      const bottom = doc.page.height - 30;
      doc.fillColor(COLORS.muted).font('Helvetica').fontSize(8)
        .text(
          `AuditDelta Report  •  Page ${i + 1} of ${pages.count}  •  Generated ${new Date().toISOString()}`,
          doc.page.margins.left,
          bottom,
          { width: doc.page.width - doc.page.margins.left - doc.page.margins.right, align: 'center' }
        );
    }
  }

  private formatTimestamp(iso: string): string {
    try {
      return new Date(iso).toLocaleString('en-US', {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hour12: true,
      });
    } catch {
      return iso;
    }
  }
}
