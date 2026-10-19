/**
 * Long-term Setup Audit Trail archive. Salesforce keeps 180 days; this keeps every entry
 * in Postgres (optionally bounded by AUDIT_ARCHIVE_RETENTION_DAYS).
 */

import { AuditEventInput } from './databaseService';
import { authService, getDatabase } from './container';

const HWM_JOB = 'audit_archive_hwm';
const BACKFILL_DAYS = 180;
const PAGE_SIZE = 2000;
const DAY_MS = 24 * 60 * 60 * 1000;

interface AuditTrailRecord {
  Id: string;
  Action?: string;
  Section?: string;
  Display?: string;
  CreatedDate: string;
  CreatedById?: string;
  CreatedBy?: { Name?: string };
  DelegateUser?: string;
}

function toEvent(r: AuditTrailRecord): AuditEventInput {
  return {
    id: r.Id,
    action: r.Action ?? null,
    section: r.Section ?? null,
    display: r.Display ?? null,
    createdDate: r.CreatedDate,
    createdById: r.CreatedById ?? null,
    createdByName: r.CreatedBy?.Name ?? null,
    delegateUser: r.DelegateUser ?? null,
  };
}

export class AuditArchiveService {
  private backfilling = new Set<string>();
  private lastRetentionRun = 0;

  /** Called every monitor cycle: backfills a new org in the background, otherwise ingests incrementally. */
  async sync(orgId: string): Promise<void> {
    await this.applyRetentionIfDue();
    if (this.backfilling.has(orgId)) return;

    const hwm = await getDatabase().getJobState(orgId, HWM_JOB);
    if (!hwm) {
      this.backfilling.add(orgId);
      const since = new Date(Date.now() - BACKFILL_DAYS * DAY_MS);
      console.log(`[AuditArchive] Backfilling org ${orgId} since ${since.toISOString()}`);
      void this.ingestSince(orgId, since)
        .then((count) => console.log(`[AuditArchive] Backfill done for ${orgId}: ${count} entries`))
        .catch((error) => console.error(`[AuditArchive] Backfill failed for ${orgId}:`, error))
        .finally(() => this.backfilling.delete(orgId));
      return;
    }

    const count = await this.ingestSince(orgId, new Date(hwm));
    if (count > 0) console.log(`[AuditArchive] Archived ${count} new entries for ${orgId}`);
  }

  isBackfilling(orgId: string): boolean {
    return this.backfilling.has(orgId);
  }

  /**
   * Pages forward by CreatedDate. The high-water mark is saved after every page, so an
   * interrupted backfill resumes where it stopped; overlap is absorbed by ON CONFLICT DO NOTHING.
   */
  private async ingestSince(orgId: string, since: Date): Promise<number> {
    const db = getDatabase();
    const conn = await authService.getConnection(orgId);
    let cursor = since;
    let inserted = 0;

    for (;;) {
      const soql =
        'SELECT Id, Action, Section, Display, CreatedDate, CreatedById, CreatedBy.Name, DelegateUser ' +
        `FROM SetupAuditTrail WHERE CreatedDate >= ${cursor.toISOString()} ` +
        `ORDER BY CreatedDate ASC LIMIT ${PAGE_SIZE}`;
      const result = await conn.query<AuditTrailRecord>(soql);
      const records = result.records;
      if (records.length === 0) break;

      inserted += await db.insertAuditEvents(orgId, records.map(toEvent));
      const last = new Date(records[records.length - 1].CreatedDate);
      await db.setJobState(orgId, HWM_JOB, last.toISOString());
      if (records.length < PAGE_SIZE) break;
      // A full page sharing one timestamp would never advance; step past it.
      cursor = last.getTime() > cursor.getTime() ? last : new Date(cursor.getTime() + 1);
    }

    if (inserted === 0 && !(await db.getJobState(orgId, HWM_JOB))) {
      await db.setJobState(orgId, HWM_JOB, new Date().toISOString());
    }
    return inserted;
  }

  private async applyRetentionIfDue(): Promise<void> {
    const days = parseInt(process.env.AUDIT_ARCHIVE_RETENTION_DAYS || '', 10);
    if (!Number.isFinite(days) || days <= 0) return;
    if (Date.now() - this.lastRetentionRun < DAY_MS) return;
    this.lastRetentionRun = Date.now();
    const deleted = await getDatabase().deleteAuditEventsOlderThan(days);
    if (deleted > 0) console.log(`[AuditArchive] Retention removed ${deleted} entries older than ${days} days`);
  }
}
