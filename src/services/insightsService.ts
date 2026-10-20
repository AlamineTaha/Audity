/**
 * Data loading for insight tools: Flow version history (Tooling API + Postgres cache) and the
 * audit archive. The analysis itself lives in src/analysis (pure, testable).
 */

import { computeOwnership, FlowVersionInput, OwnershipResult } from '../analysis/flowOwnership';
import { computeHotspots, HotspotCategory, HotspotResult } from '../analysis/hotspots';
import { authService, getDatabase, salesforceService } from './container';

const METADATA_CONCURRENCY = 4;
const USER_QUERY_CHUNK = 100;

interface FlowVersionRecord {
  Id: string;
  VersionNumber: number;
  Status: string;
  CreatedDate: string;
  CreatedById?: string | null;
  LastModifiedById?: string | null;
}

const soqlId = (id: string) => `'${id.replace(/[^a-zA-Z0-9]/g, '')}'`;

async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}

export interface FlowOwnershipData {
  developerName: string;
  label: string;
  result: OwnershipResult;
  versionsAnalyzed: number;
  versionsFailed: number;
}

export async function loadFlowOwnership(orgId: string, flowNameOrLabel: string, maxVersions: number): Promise<FlowOwnershipData> {
  const flow = await salesforceService.resolveFlowDefinition(orgId, flowNameOrLabel);
  const conn = await authService.getConnection(orgId);

  // One extra version so the oldest analyzed one has a predecessor to diff against.
  const versionResult = await conn.tooling.query<FlowVersionRecord>(
    'SELECT Id, VersionNumber, Status, CreatedDate, CreatedById, LastModifiedById FROM Flow ' +
      `WHERE DefinitionId = ${soqlId(flow.definitionId)} ORDER BY VersionNumber DESC LIMIT ${maxVersions + 1}`
  );
  const records = [...versionResult.records].reverse();
  const hasBaseline = records.length > maxVersions;

  // Non-draft versions are immutable; activation only changes LastModifiedBy, so CreatedBy is the author.
  const authorOf = (r: FlowVersionRecord) => r.CreatedById || r.LastModifiedById || 'unknown';
  const userIds = [...new Set(records.map(authorOf).filter((id) => id !== 'unknown'))];
  const names = new Map<string, string>();
  for (let i = 0; i < userIds.length; i += USER_QUERY_CHUNK) {
    const chunk = userIds.slice(i, i + USER_QUERY_CHUNK);
    const users = await conn.query<{ Id: string; Name: string }>(`SELECT Id, Name FROM User WHERE Id IN (${chunk.map(soqlId).join(',')})`);
    for (const u of users.records) names.set(u.Id, u.Name);
  }

  const db = getDatabase();
  const cached = await db.getCachedFlowVersions(orgId, records.filter((r) => r.Status !== 'Draft').map((r) => r.Id));
  let versionsFailed = 0;
  const metadata = await mapWithConcurrency(records, METADATA_CONCURRENCY, async (r) => {
    if (cached.has(r.Id)) return cached.get(r.Id);
    try {
      // The Tooling API only returns Metadata when the query selects a single record.
      const res = await conn.tooling.query<{ Metadata: unknown }>(`SELECT Id, Metadata FROM Flow WHERE Id = ${soqlId(r.Id)} LIMIT 1`);
      const meta = res.records[0]?.Metadata ?? null;
      if (meta && r.Status !== 'Draft') await db.cacheFlowVersion(orgId, r.Id, r.VersionNumber, meta);
      return meta;
    } catch (error) {
      versionsFailed++;
      console.warn(`[Insights] Could not load metadata for ${flow.developerName} v${r.VersionNumber}:`, (error as Error).message);
      return null;
    }
  });

  const versions: FlowVersionInput[] = records.map((r, i) => ({
    versionNumber: r.VersionNumber,
    authorId: authorOf(r),
    authorName: names.get(authorOf(r)) ?? 'Unknown user',
    createdDate: r.CreatedDate,
    metadata: metadata[i] ?? null,
  }));

  return {
    developerName: flow.developerName,
    label: flow.label,
    result: computeOwnership(versions, hasBaseline),
    versionsAnalyzed: records.length - (hasBaseline ? 1 : 0),
    versionsFailed,
  };
}

export interface HotspotData extends HotspotResult {
  archiveOldest: Date | null;
}

export async function loadChangeHotspots(orgId: string, days: number, category: HotspotCategory | undefined, limit: number): Promise<HotspotData> {
  const db = getDatabase();
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const [rows, stats] = await Promise.all([db.getAuditEventsSince(orgId, since), db.getAuditArchiveStats(orgId)]);
  const result = computeHotspots(
    rows.map((r) => ({ action: r.action, section: r.section, display: r.display, createdByName: r.created_by_name, createdDate: r.created_date })),
    { category, limit }
  );
  return { ...result, archiveOldest: stats.oldest };
}
