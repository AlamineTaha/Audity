/**
 * "git blame" for Flows: who wrote the logic that is live now, versus who touched it most
 * or last. Pure functions over version metadata; no Salesforce calls.
 */

import { diffFlowVersions, elementKey, FLOW_PROPERTIES_KEY, highestSeverity, logicFieldKey, logicFields } from './flowDiff';

export const EARLIER_VERSIONS_ID = '__earlier__';
const BUS_FACTOR_THRESHOLD = 0.8;

export interface FlowVersionInput {
  versionNumber: number;
  authorId: string;
  authorName: string;
  createdDate: string;
  /** null when the metadata could not be loaded; the version is then skipped. */
  metadata: unknown | null;
}

export interface OwnerStats {
  authorId: string;
  name: string;
  /** Share (0–1) of the latest version's fields last written by this author (field-level blame). */
  liveShare: number;
  /** Fields this author added, changed or removed across all analyzed versions. */
  effort: number;
  versions: number;
  lastChange?: string;
}

export interface TimelinePoint {
  version: number;
  author: string;
  date: string;
  changedFields: number;
  risk: 'CRITICAL' | 'HIGH' | null;
}

export interface OwnershipResult {
  owners: OwnerStats[];
  timeline: TimelinePoint[];
  latestVersion: number;
  /** Set when older versions exist beyond the analyzed window. */
  baselineVersion?: number;
  mainOwner?: OwnerStats;
  latestEditor?: { name: string; version: number; authorId: string };
  busFactorRisk: boolean;
}

/**
 * @param versions Ascending by version number. When `hasBaseline`, versions[0] is only the
 *   starting point: its content is credited to "earlier versions", not to its editor.
 */
export function computeOwnership(versions: FlowVersionInput[], hasBaseline: boolean): OwnershipResult {
  const loaded = versions.filter((v) => v.metadata !== null);
  const names = new Map<string, string>([[EARLIER_VERSIONS_ID, 'Earlier versions']]);
  /** logicFieldKey -> author id of the version that last set that field. */
  const attribution = new Map<string, string>();
  const effort = new Map<string, { fields: number; versions: number; last?: string }>();
  const timeline: TimelinePoint[] = [];

  let previous: unknown = {};
  let start = 0;
  if (hasBaseline && loaded.length > 0) {
    previous = loaded[0].metadata;
    for (const key of logicFields(previous)) attribution.set(key, EARLIER_VERSIONS_ID);
    names.set(EARLIER_VERSIONS_ID, `Up to v${loaded[0].versionNumber}`);
    start = 1;
  }

  for (const version of loaded.slice(start)) {
    names.set(version.authorId, version.authorName);
    const diff = diffFlowVersions(previous, version.metadata, '', undefined, version.versionNumber);
    let changedFields = 0;
    const credit = (owner: string, path: string, removed: boolean) => {
      const key = logicFieldKey(owner, path);
      if (removed) attribution.delete(key);
      else attribution.set(key, version.authorId);
    };
    for (const f of diff.propertyChanges) {
      credit(FLOW_PROPERTIES_KEY, f.path, f.after === undefined);
      changedFields++;
    }
    for (const e of diff.elements) {
      const owner = elementKey(e.type, e.name);
      if (e.change === 'removed') {
        for (const key of [...attribution.keys()]) if (key.startsWith(`${owner}|`)) attribution.delete(key);
        changedFields++;
        continue;
      }
      for (const f of e.fields) credit(owner, f.path, f.after === undefined);
      changedFields += e.fields.length;
    }

    const stats = effort.get(version.authorId) ?? { fields: 0, versions: 0 };
    stats.fields += changedFields;
    stats.versions += 1;
    if (!stats.last || version.createdDate > stats.last) stats.last = version.createdDate;
    effort.set(version.authorId, stats);

    const severity = highestSeverity(diff.findings, true);
    timeline.push({
      version: version.versionNumber,
      author: version.authorName,
      date: version.createdDate,
      changedFields,
      risk: severity === 'CRITICAL' || severity === 'HIGH' ? severity : null,
    });
    previous = version.metadata;
  }

  const live = new Map<string, number>();
  let totalWeight = 0;
  for (const key of logicFields(previous)) {
    const owner = attribution.get(key) ?? EARLIER_VERSIONS_ID;
    live.set(owner, (live.get(owner) ?? 0) + 1);
    totalWeight++;
  }

  const ids = new Set([...live.keys(), ...effort.keys()]);
  const owners: OwnerStats[] = [...ids]
    .map((id) => ({
      authorId: id,
      name: names.get(id) ?? id,
      liveShare: totalWeight ? (live.get(id) ?? 0) / totalWeight : 0,
      effort: effort.get(id)?.fields ?? 0,
      versions: effort.get(id)?.versions ?? 0,
      lastChange: effort.get(id)?.last,
    }))
    .sort((a, b) => b.liveShare - a.liveShare || b.effort - a.effort);

  const people = owners.filter((o) => o.authorId !== EARLIER_VERSIONS_ID);
  const mainOwner = people[0];
  const last = loaded[loaded.length - 1];
  const latestEditor = last && !(hasBaseline && loaded.length === 1)
    ? { name: last.authorName, version: last.versionNumber, authorId: last.authorId }
    : undefined;

  return {
    owners,
    timeline,
    latestVersion: last?.versionNumber ?? 0,
    baselineVersion: hasBaseline ? loaded[0]?.versionNumber : undefined,
    mainOwner,
    latestEditor,
    busFactorRisk: Boolean(mainOwner && mainOwner.liveShare > BUS_FACTOR_THRESHOLD),
  };
}

const pct = (share: number) => `${Math.round(share * 100)}%`;
const day = (iso?: string) => (iso ? iso.slice(0, 10) : '—');

export function ownershipDisplayText(flowName: string, result: OwnershipResult): string {
  if (result.timeline.length === 0) return `No analyzable versions found for \`${flowName}\`.`;
  const lines: string[] = [];
  const { mainOwner, latestEditor } = result;
  const window = result.baselineVersion !== undefined
    ? `v${result.baselineVersion + 1}–v${result.latestVersion}`
    : `v1–v${result.latestVersion}`;

  if (mainOwner) {
    lines.push(`*Owner of \`${flowName}\`: ${mainOwner.name}* — wrote ${pct(mainOwner.liveShare)} of the logic that is live in v${result.latestVersion} (analyzed ${window}).`);
  }
  if (latestEditor && mainOwner && latestEditor.authorId !== mainOwner.authorId) {
    const editor = result.owners.find((o) => o.authorId === latestEditor.authorId);
    lines.push(
      `The last editor (v${latestEditor.version}) was *${latestEditor.name}*, who owns only ${pct(editor?.liveShare ?? 0)} of the live logic — ask ${mainOwner.name} about how this flow works.`
    );
  }
  const earlier = result.owners.find((o) => o.authorId === EARLIER_VERSIONS_ID);
  if (earlier && mainOwner && earlier.liveShare > mainOwner.liveShare) {
    lines.push(`Note: ${pct(earlier.liveShare)} of the live logic predates v${(result.baselineVersion ?? 0) + 1}; analyze more versions (maxVersions) to see who wrote it.`);
  }
  if (result.busFactorRisk && mainOwner) {
    lines.push(`:warning: Bus factor: ${mainOwner.name} owns more than 80% of the live logic, so knowledge of this flow sits with one person.`);
  }

  lines.push('', '*Ownership* (live share · effort in changed fields · versions · last change)');
  for (const o of result.owners) {
    lines.push(`• ${o.name}: ${pct(o.liveShare)} · ${o.effort} · ${o.versions} · ${day(o.lastChange)}`);
  }

  const risky = result.timeline.filter((t) => t.risk);
  if (risky.length) {
    lines.push('', `*Versions that introduced high risk:* ${risky.map((t) => `v${t.version} (${t.risk}, ${t.author})`).join(', ')}`);
  }
  return lines.join('\n');
}
