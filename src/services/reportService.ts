import PDFDocument from 'pdfkit';
import { AuditReportEntry, AuditReportProcessType } from '../types';

const C = {
  brand:        '#1A4F8C',
  brandDark:    '#0F2D52',
  accent:       '#0EA5E9',
  accentLight:  '#E0F2FE',
  success:      '#059669',
  successBg:    '#D1FAE5',
  warning:      '#D97706',
  warningBg:    '#FEF3C7',
  danger:       '#DC2626',
  dangerBg:     '#FEE2E2',
  critical:     '#7C3AED',
  criticalBg:   '#EDE9FE',
  text:         '#111827',
  sub:          '#374151',
  muted:        '#6B7280',
  faint:        '#9CA3AF',
  border:       '#E5E7EB',
  bg:           '#F9FAFB',
  bgAlt:        '#F3F4F6',
  white:        '#FFFFFF',
};

const PROCESS_ACCENT: Record<string, string> = {
  Flow:           '#0EA5E9',
  Permission:     '#8B5CF6',
  Layout:         '#10B981',
  ValidationRule: '#F59E0B',
  CustomField:    '#EC4899',
  Object:         '#F97316',
  All:            '#1A4F8C',
};

export class ReportService {
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
        margins: { top: 50, bottom: 60, left: 48, right: 48 },
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

      const L = doc.page.margins.left;
      const W = doc.page.width - L - doc.page.margins.right;

      let y = doc.page.margins.top;
      y = this.drawCover(doc, L, W, y, processType, hours, orgId, entries.length);
      y = this.drawSummary(doc, L, W, y, overallSummary);
      this.drawEntries(doc, L, W, y, entries);
      this.drawFooters(doc);

      doc.end();
    });
  }

  // ─── Cover ────────────────────────────────────────────────────────────────

  private drawCover(
    doc: PDFKit.PDFDocument,
    L: number, W: number, startY: number,
    processType: string, hours: number, orgId: string, total: number
  ): number {
    const BAND_H = 120;
    const bandY = startY;

    // Brand header band
    doc.rect(L, bandY, W, BAND_H).fill(C.brand);
    // Accent stripe at top of band
    doc.rect(L, bandY, W, 5).fill(C.accent);

    // Title
    doc.fillColor(C.white).font('Helvetica-Bold').fontSize(30)
      .text('AuditDelta', L + 20, bandY + 24, { lineBreak: false });
    doc.fillColor(C.accent).font('Helvetica').fontSize(14)
      .text('Audit Report', L + 20, bandY + 62, { lineBreak: false });
    doc.fillColor('#B3D9F0').font('Helvetica').fontSize(9.5)
      .text('AI-Powered Salesforce Setup Audit Trail Analysis', L + 20, bandY + 83, { lineBreak: false });

    // Process type pill (top-right of band)
    doc.font('Helvetica-Bold').fontSize(8.5);
    const ptLabel = processType.toUpperCase() + ' REPORT';
    const ptLabelW = doc.widthOfString(ptLabel);
    const pillW = ptLabelW + 18;
    const pillH = 22;
    const pillX = L + W - pillW - 14;
    const pillY = bandY + 22;
    doc.rect(pillX, pillY, pillW, pillH).fill(C.accent);
    doc.fillColor(C.white).font('Helvetica-Bold').fontSize(8.5)
      .text(ptLabel, pillX + 9, pillY + 7, { lineBreak: false });

    let y = bandY + BAND_H + 22;

    // 2×2 stat card grid
    const CARD_W = (W - 12) / 2;
    const CARD_H = 64;
    const GAP = 12;
    const displayOrgId = orgId.length > 22 ? orgId.slice(0, 22) + '…' : orgId;
    const stats = [
      { label: 'ORGANIZATION', value: displayOrgId },
      { label: 'TIME WINDOW',  value: `Last ${hours} hour${hours !== 1 ? 's' : ''}` },
      { label: 'TOTAL CHANGES', value: String(total) },
      {
        label: 'GENERATED',
        value: new Date().toLocaleString('en-US', {
          month: 'short', day: 'numeric', year: 'numeric',
          hour: '2-digit', minute: '2-digit',
        }),
      },
    ];

    for (let i = 0; i < stats.length; i++) {
      const col = i % 2;
      const row = Math.floor(i / 2);
      this.drawStatCard(
        doc,
        L + col * (CARD_W + GAP),
        y + row * (CARD_H + GAP),
        CARD_W, CARD_H,
        stats[i].label, stats[i].value
      );
    }

    y += 2 * (CARD_H + GAP) + 20;

    // Horizontal divider
    doc.rect(L, y, W, 1).fill(C.border);
    y += 22;

    return y;
  }

  private drawStatCard(
    doc: PDFKit.PDFDocument,
    x: number, y: number, w: number, h: number,
    label: string, value: string
  ): void {
    doc.rect(x, y, w, h).fill(C.bg);
    doc.rect(x, y, 3, h).fill(C.accent);
    doc.fillColor(C.muted).font('Helvetica').fontSize(7.5)
      .text(label, x + 13, y + 11, { width: w - 18, lineBreak: false });
    const fontSize = value.length > 28 ? 9.5 : 12;
    doc.fillColor(C.text).font('Helvetica-Bold').fontSize(fontSize)
      .text(value, x + 13, y + 27, { width: w - 18 });
  }

  // ─── Executive Summary ────────────────────────────────────────────────────

  private drawSummary(
    doc: PDFKit.PDFDocument,
    L: number, W: number, y: number,
    summary: string
  ): number {
    y = this.checkPage(doc, y, 110);

    // Section heading
    doc.rect(L, y, 4, 20).fill(C.accent);
    doc.fillColor(C.brand).font('Helvetica-Bold').fontSize(14)
      .text('Executive Summary', L + 13, y + 2);
    y += 32;

    // Measure callout box height
    doc.font('Helvetica').fontSize(10);
    const textH = doc.heightOfString(summary, { width: W - 34 });
    const boxH = textH + 36;

    doc.rect(L, y, W, boxH).fill(C.accentLight);
    doc.rect(L, y, 3, boxH).fill(C.accent);

    doc.fillColor(C.accent).font('Helvetica-Bold').fontSize(7.5)
      .text('AI ANALYSIS', L + 13, y + 11);
    doc.fillColor(C.sub).font('Helvetica').fontSize(10)
      .text(summary, L + 13, y + 23, { width: W - 30 });

    y += boxH + 26;
    return y;
  }

  // ─── Change Entries ───────────────────────────────────────────────────────

  private drawEntries(
    doc: PDFKit.PDFDocument,
    L: number, W: number, y: number,
    entries: AuditReportEntry[]
  ): void {
    y = this.checkPage(doc, y, 60);

    doc.rect(L, y, 4, 20).fill(C.accent);
    doc.fillColor(C.brand).font('Helvetica-Bold').fontSize(14)
      .text(`Change Details  (${entries.length} entr${entries.length === 1 ? 'y' : 'ies'})`, L + 13, y + 2);
    y += 32;

    if (entries.length === 0) {
      doc.fillColor(C.muted).font('Helvetica-Oblique').fontSize(10)
        .text('No changes found for the selected criteria.', L, y);
      return;
    }

    for (let i = 0; i < entries.length; i++) {
      y = this.drawCard(doc, L, W, y, entries[i], i);
    }
  }

  private drawCard(
    doc: PDFKit.PDFDocument,
    L: number, W: number, y: number,
    entry: AuditReportEntry, index: number
  ): number {
    const STRIP  = 4;
    const PAD_H  = 14;
    const PAD_V  = 12;
    const META_H = 16;
    const innerW = W - STRIP - PAD_H * 2;

    // Measure all text blocks first (font must be set before measuring)
    doc.font('Helvetica-Bold').fontSize(10.5);
    const actionH = doc.heightOfString(entry.action, { width: innerW });

    doc.font('Helvetica').fontSize(9);
    const displayH = doc.heightOfString(entry.display, { width: innerW });

    let explBoxH = 0;
    if (entry.explanation) {
      doc.font('Helvetica').fontSize(9.5);
      const textH = doc.heightOfString(entry.explanation, { width: innerW - 16 });
      explBoxH = textH + 30; // padding above + label row + padding below
    }

    const cardH =
      PAD_V
      + META_H + 6
      + actionH + 5
      + displayH
      + (explBoxH > 0 ? 12 + explBoxH : 0)
      + PAD_V;

    y = this.checkPage(doc, y, cardH + 2);

    // Card background (alternating)
    doc.rect(L, y, W, cardH).fill(index % 2 === 0 ? C.white : C.bg);

    // Left accent strip colored by process type
    const accentCol = PROCESS_ACCENT[entry.processType] ?? C.accent;
    doc.rect(L, y, STRIP, cardH).fill(accentCol);

    // Bottom separator
    doc.rect(L, y + cardH, W, 0.5).fill(C.border);

    const ix = L + STRIP + PAD_H;
    let ty = y + PAD_V;

    // ── Meta row ──────────────────────────────────────────────────────────
    const metaText = `#${index + 1}  ·  ${this.formatTimestamp(entry.timestamp)}  ·  ${entry.user}`;
    doc.fillColor(C.faint).font('Helvetica').fontSize(8)
      .text(metaText, ix, ty, { width: innerW - 90, lineBreak: false });

    // Process type badge (right-aligned, light gray bg)
    doc.font('Helvetica-Bold').fontSize(7.5);
    const badgeText = entry.processType;
    const badgeTW = doc.widthOfString(badgeText);
    const badgeW  = badgeTW + 12;
    const badgeX  = L + W - badgeW - 8;
    const badgeY  = ty - 3;
    doc.rect(badgeX, badgeY, badgeW, 14).fill(C.bgAlt);
    doc.fillColor(accentCol).font('Helvetica-Bold').fontSize(7.5)
      .text(badgeText, badgeX + 6, ty, { lineBreak: false });

    ty += META_H + 4;

    // ── Action title ──────────────────────────────────────────────────────
    doc.fillColor(C.text).font('Helvetica-Bold').fontSize(10.5)
      .text(entry.action, ix, ty, { width: innerW });
    ty += actionH + 5;

    // ── Display name ──────────────────────────────────────────────────────
    doc.fillColor(C.sub).font('Helvetica').fontSize(9)
      .text(entry.display, ix, ty, { width: innerW });
    ty += displayH;

    // ── AI Explanation callout ────────────────────────────────────────────
    if (entry.explanation) {
      ty += 12;
      doc.rect(ix, ty, innerW, explBoxH).fill(C.accentLight);
      doc.rect(ix, ty, 2, explBoxH).fill(C.accent);

      doc.fillColor(C.accent).font('Helvetica-Bold').fontSize(7.5)
        .text('AI EXPLANATION', ix + 10, ty + 9);
      doc.fillColor(C.sub).font('Helvetica').fontSize(9.5)
        .text(entry.explanation, ix + 10, ty + 20, { width: innerW - 18 });
      ty += explBoxH;
    }

    return y + cardH + 1;
  }

  // ─── Footers (all pages) ──────────────────────────────────────────────────

  private drawFooters(doc: PDFKit.PDFDocument): void {
    const range = doc.bufferedPageRange();
    const ts = new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC';

    for (let i = 0; i < range.count; i++) {
      doc.switchToPage(i);
      const L = doc.page.margins.left;
      const W = doc.page.width - L - doc.page.margins.right;
      const fy = doc.page.height - 38;

      doc.rect(L, fy, W, 0.5).fill(C.border);

      doc.fillColor(C.faint).font('Helvetica').fontSize(7.5)
        .text('AuditDelta Guardian', L, fy + 10, { lineBreak: false });

      doc.fillColor(C.faint).font('Helvetica').fontSize(7.5)
        .text(`Page ${i + 1} of ${range.count}`, L, fy + 10, {
          width: W, align: 'center', lineBreak: false,
        });

      doc.fillColor(C.faint).font('Helvetica').fontSize(7.5)
        .text(ts, L, fy + 10, { width: W, align: 'right', lineBreak: false });
    }
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  private checkPage(
    doc: PDFKit.PDFDocument,
    y: number, needed: number
  ): number {
    const limit = doc.page.height - doc.page.margins.bottom;
    if (y + needed > limit) {
      doc.addPage();
      const nL = doc.page.margins.left;
      const nW = doc.page.width - nL - doc.page.margins.right;
      // Thin accent stripe at top of continuation pages
      doc.rect(nL, doc.page.margins.top, nW, 3).fill(C.accent);
      return doc.page.margins.top + 16;
    }
    return y;
  }

  private formatTimestamp(iso: string): string {
    try {
      return new Date(iso).toLocaleString('en-US', {
        month: 'short', day: 'numeric',
        hour: '2-digit', minute: '2-digit',
        hour12: true,
      });
    } catch {
      return iso;
    }
  }
}
