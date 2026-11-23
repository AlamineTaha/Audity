/**
 * Deploy Watch analysis: turns a Metadata API deploy result into facts (failures, missing
 * dependencies checked against the org, code context) and asks the LLM to explain them.
 */

import type { Connection } from 'jsforce';
import { getLlm } from '../llm';

export type DeployStatus = 'Pending' | 'InProgress' | 'Succeeded' | 'SucceededPartial' | 'Failed' | 'Canceling' | 'Canceled';
export const FINAL_STATUSES: ReadonlySet<string> = new Set(['Succeeded', 'SucceededPartial', 'Failed', 'Canceled']);

export interface DeploySnapshot {
  id: string;
  status: DeployStatus;
  checkOnly: boolean;
  createdById: string;
  createdByName: string;
  createdDate: string;
  startDate?: string;
  completedDate?: string;
  componentsTotal: number;
  componentsDeployed: number;
  componentErrors: number;
  testsTotal: number;
  testsCompleted: number;
  testErrors: number;
  stateDetail?: string;
  testLevel?: string;
  changeSetName?: string;
  errorMessage?: string;
}

export interface ComponentFailure {
  type: string;
  name: string;
  fileName?: string;
  line?: number;
  column?: number;
  problem: string;
}

export interface TestFailure {
  className: string;
  methodName: string;
  message: string;
  stackTrace?: string;
}

export interface CoverageWarning {
  name?: string;
  message: string;
}

export interface DeployDetails {
  componentFailures: ComponentFailure[];
  testFailures: TestFailure[];
  coverageWarnings: CoverageWarning[];
}

export interface Dependency {
  kind: 'class' | 'field' | 'object';
  name: string;
  object?: string;
  /** Whether it exists in the target org right now. */
  exists: boolean;
  referencedBy: string;
}

const asArray = <T>(v: T | T[] | undefined | null): T[] => (Array.isArray(v) ? v : v ? [v] : []);
const soqlValue = (v: string) => v.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

const DEPLOY_REQUEST_FIELDS =
  'Id, Status, CheckOnly, CreatedById, CreatedBy.Name, CreatedDate, StartDate, CompletedDate, ' +
  'NumberComponentsTotal, NumberComponentsDeployed, NumberComponentErrors, NumberTestsTotal, ' +
  'NumberTestsCompleted, NumberTestErrors, StateDetail, TestLevel, ChangeSetName, ErrorMessage';

interface DeployRequestRecord {
  Id: string;
  Status: DeployStatus;
  CheckOnly: boolean;
  CreatedById: string;
  CreatedBy?: { Name?: string };
  CreatedDate: string;
  StartDate?: string;
  CompletedDate?: string;
  NumberComponentsTotal?: number;
  NumberComponentsDeployed?: number;
  NumberComponentErrors?: number;
  NumberTestsTotal?: number;
  NumberTestsCompleted?: number;
  NumberTestErrors?: number;
  StateDetail?: string;
  TestLevel?: string;
  ChangeSetName?: string;
  ErrorMessage?: string;
}

function toSnapshot(r: DeployRequestRecord): DeploySnapshot {
  return {
    id: r.Id,
    status: r.Status,
    checkOnly: Boolean(r.CheckOnly),
    createdById: r.CreatedById,
    createdByName: r.CreatedBy?.Name ?? 'Unknown',
    createdDate: r.CreatedDate,
    startDate: r.StartDate ?? undefined,
    completedDate: r.CompletedDate ?? undefined,
    componentsTotal: r.NumberComponentsTotal ?? 0,
    componentsDeployed: r.NumberComponentsDeployed ?? 0,
    componentErrors: r.NumberComponentErrors ?? 0,
    testsTotal: r.NumberTestsTotal ?? 0,
    testsCompleted: r.NumberTestsCompleted ?? 0,
    testErrors: r.NumberTestErrors ?? 0,
    stateDetail: r.StateDetail ?? undefined,
    testLevel: r.TestLevel ?? undefined,
    changeSetName: r.ChangeSetName ?? undefined,
    errorMessage: r.ErrorMessage ?? undefined,
  };
}

export async function queryDeploys(conn: Connection, sinceIso: string, limit = 50): Promise<DeploySnapshot[]> {
  const result = await conn.tooling.query<DeployRequestRecord>(
    `SELECT ${DEPLOY_REQUEST_FIELDS} FROM DeployRequest WHERE CreatedDate >= ${sinceIso} ORDER BY CreatedDate ASC LIMIT ${limit}`
  );
  return result.records.map(toSnapshot);
}

export async function getDeploy(conn: Connection, deployId?: string): Promise<DeploySnapshot | null> {
  const where = deployId ? `WHERE Id = '${soqlValue(deployId)}'` : 'WHERE CreatedDate = LAST_N_DAYS:7';
  const result = await conn.tooling.query<DeployRequestRecord>(
    `SELECT ${DEPLOY_REQUEST_FIELDS} FROM DeployRequest ${where} ORDER BY CreatedDate DESC LIMIT 1`
  );
  return result.records[0] ? toSnapshot(result.records[0]) : null;
}

/** Failures from Metadata API checkDeployStatus(id, includeDetails=true). */
export async function fetchDetails(conn: Connection, deployId: string): Promise<DeployDetails> {
  const result = (await conn.metadata.checkDeployStatus(deployId, true)) as unknown as {
    details?: {
      componentFailures?: unknown;
      runTestResult?: { failures?: unknown; codeCoverageWarnings?: unknown };
    };
  };
  const details = result.details ?? {};
  const componentFailures = asArray(details.componentFailures as Record<string, unknown>[]).map((c) => ({
    type: String(c.componentType || 'Component'),
    name: String(c.fullName || c.fileName || 'unknown'),
    fileName: c.fileName ? String(c.fileName) : undefined,
    line: c.lineNumber ? Number(c.lineNumber) : undefined,
    column: c.columnNumber ? Number(c.columnNumber) : undefined,
    problem: String(c.problem || 'Unknown error'),
  }));
  const testFailures = asArray(details.runTestResult?.failures as Record<string, unknown>[]).map((t) => ({
    className: String(t.name || 'UnknownTest'),
    methodName: String(t.methodName || 'unknown'),
    message: String(t.message || ''),
    stackTrace: t.stackTrace ? String(t.stackTrace) : undefined,
  }));
  const coverageWarnings = asArray(details.runTestResult?.codeCoverageWarnings as Record<string, unknown>[]).map((w) => ({
    name: w.name ? String(w.name) : undefined,
    message: String(w.message || ''),
  }));
  return { componentFailures, testFailures, coverageWarnings };
}

// ---------------- Missing dependencies (deterministic) ----------------

const DEPENDENCY_PATTERNS: Array<{ re: RegExp; build: (m: RegExpMatchArray) => Omit<Dependency, 'exists' | 'referencedBy'> | null }> = [
  { re: /No such column '([\w]+)' on entity '([\w]+)'/i, build: (m) => ({ kind: 'field', name: m[1], object: m[2] }) },
  { re: /Field does not exist: ([\w]+) on ([\w]+)/i, build: (m) => ({ kind: 'field', name: m[1], object: m[2] }) },
  { re: /Invalid type: ([\w.]+)/i, build: (m) => (/__c$/i.test(m[1]) ? { kind: 'object', name: m[1] } : { kind: 'class', name: m[1] }) },
  {
    re: /Variable does not exist: ([\w]+)/i,
    // A custom-field-looking name is a field; a PascalCase name is most likely a class.
    build: (m) => (/__c$/i.test(m[1]) ? { kind: 'field', name: m[1] } : /^[A-Z]\w+$/.test(m[1]) ? { kind: 'class', name: m[1] } : null),
  },
  { re: /Dependent class is invalid and needs recompilation:\s*(?:Class\s+)?([\w]+)/i, build: (m) => ({ kind: 'class', name: m[1] }) },
];

function extractDependencies(details: DeployDetails): Omit<Dependency, 'exists'>[] {
  const found = new Map<string, Omit<Dependency, 'exists'>>();
  const messages = [
    ...details.componentFailures.map((f) => ({ text: f.problem, by: f.name })),
    ...details.testFailures.map((f) => ({ text: f.message, by: `${f.className}.${f.methodName}` })),
  ];
  for (const { text, by } of messages) {
    for (const { re, build } of DEPENDENCY_PATTERNS) {
      const m = text.match(re);
      const dep = m && build(m);
      if (!dep) continue;
      const key = `${dep.kind}:${dep.object ?? ''}:${dep.name}`.toLowerCase();
      if (!found.has(key)) found.set(key, { ...dep, referencedBy: by });
    }
  }
  return [...found.values()];
}

async function existsInOrg(conn: Connection, dep: Omit<Dependency, 'exists'>): Promise<boolean> {
  if (dep.kind === 'class') {
    const r = await conn.tooling.query<{ Id: string }>(`SELECT Id FROM ApexClass WHERE Name = '${soqlValue(dep.name)}' LIMIT 1`);
    return r.records.length > 0;
  }
  if (dep.kind === 'object') {
    const r = await conn.query<{ QualifiedApiName: string }>(
      `SELECT QualifiedApiName FROM EntityDefinition WHERE QualifiedApiName = '${soqlValue(dep.name)}' LIMIT 1`
    );
    return r.records.length > 0;
  }
  // Fields: custom fields by developer name (no "__c"), optionally on a known object.
  const parts = dep.name.replace(/__c$/i, '').split('__');
  const developerName = parts[parts.length - 1];
  const r = await conn.tooling.query<{ TableEnumOrId: string }>(
    `SELECT TableEnumOrId FROM CustomField WHERE DeveloperName = '${soqlValue(developerName)}' LIMIT 20`
  );
  if (!dep.object) return r.records.length > 0;
  const objects = new Set(r.records.map((x) => x.TableEnumOrId.toLowerCase()));
  if (objects.has(dep.object.toLowerCase())) return true;
  // Custom objects are identified by Id in TableEnumOrId; fall back to "exists somewhere".
  return r.records.some((x) => x.TableEnumOrId.startsWith('01I'));
}

export async function checkDependencies(conn: Connection, details: DeployDetails): Promise<Dependency[]> {
  const deps = extractDependencies(details);
  return Promise.all(
    deps.map(async (dep) => ({ ...dep, exists: await existsInOrg(conn, dep).catch(() => true) }))
  );
}

// ---------------- Code context ----------------

const STACK_FRAME_RE = /Class\.([\w]+)\.[\w<>]+: line (\d+)/g;
const MAX_CLASSES = 4;
const CONTEXT_LINES = 8;

interface CodeExcerpt {
  className: string;
  lines: string;
}

/**
 * The org's *current* code for classes named in failures. A failed deploy never saved the new
 * version, so this may differ from what was being deployed — the prompt says so.
 */
async function codeContext(conn: Connection, details: DeployDetails): Promise<CodeExcerpt[]> {
  const wanted = new Map<string, Set<number>>();
  const want = (name: string, line?: number) => {
    const set = wanted.get(name) ?? new Set<number>();
    if (line) set.add(line);
    wanted.set(name, set);
  };
  for (const f of details.componentFailures) {
    if (/^Apex(Class|Trigger)$/.test(f.type)) want(f.name, f.line);
  }
  for (const t of details.testFailures) {
    want(t.className);
    for (const m of (t.stackTrace ?? '').matchAll(STACK_FRAME_RE)) want(m[1], Number(m[2]));
  }

  const names = [...wanted.keys()].slice(0, MAX_CLASSES);
  if (names.length === 0) return [];
  const r = await conn.tooling.query<{ Name: string; Body: string }>(
    `SELECT Name, Body FROM ApexClass WHERE Name IN (${names.map((n) => `'${soqlValue(n)}'`).join(',')})`
  );
  return r.records.map((cls) => {
    const all = (cls.Body || '').split('\n');
    const lines = [...(wanted.get(cls.Name) ?? [])];
    const ranges = lines.length
      ? lines.map((l) => [Math.max(1, l - CONTEXT_LINES), Math.min(all.length, l + CONTEXT_LINES)] as const)
      : [[1, Math.min(all.length, 60)] as const];
    const excerpt = ranges
      .map(([from, to]) => all.slice(from - 1, to).map((text, i) => `${String(from + i).padStart(4)}| ${text}`).join('\n'))
      .join('\n   …\n');
    return { className: cls.Name, lines: excerpt };
  });
}

// ---------------- Text ----------------

const kindLabel = (d: DeploySnapshot) => (d.checkOnly ? 'Validation' : 'Deployment');

export function failureFacts(details: DeployDetails, deps: Dependency[]): string[] {
  const lines: string[] = [];
  for (const f of details.componentFailures.slice(0, 15)) {
    lines.push(`• \`${f.type} ${f.name}\`${f.line ? ` (line ${f.line}${f.column ? `:${f.column}` : ''})` : ''}: ${f.problem}`);
  }
  for (const t of details.testFailures.slice(0, 10)) {
    lines.push(`• Test \`${t.className}.${t.methodName}\`: ${t.message.split('\n')[0]}`);
  }
  for (const w of details.coverageWarnings.slice(0, 5)) {
    lines.push(`• Coverage${w.name ? ` \`${w.name}\`` : ''}: ${w.message}`);
  }
  const missing = deps.filter((d) => !d.exists);
  if (missing.length) {
    lines.push('', '*Missing from the target org* (add to this deployment or deploy first):');
    for (const d of missing) lines.push(`• ${d.kind} \`${d.object ? `${d.object}.` : ''}${d.name}\` — used by \`${d.referencedBy}\``);
  }
  return lines;
}

/** LLM explanation of a failed deploy; falls back to the deterministic facts on error. */
export async function explainFailure(conn: Connection, deploy: DeploySnapshot, details: DeployDetails): Promise<string> {
  const deps = await checkDependencies(conn, details).catch(() => []);
  const facts = failureFacts(details, deps);
  if (details.componentFailures.length + details.testFailures.length + details.coverageWarnings.length === 0) {
    return deploy.errorMessage ? `*Error:* ${deploy.errorMessage}` : 'Salesforce reported no failure details for this deploy.';
  }

  const sendCode = process.env.DEPLOY_WATCH_SEND_CODE !== 'false';
  const code = sendCode ? await codeContext(conn, details).catch(() => []) : [];

  const prompt = `You are a senior Salesforce developer helping a teammate fix a failed ${kindLabel(deploy).toLowerCase()}.
Explain the failures below precisely and suggest concrete fixes. Use only these facts; if something is unknown, say so.

DEPLOY ${deploy.id} · ${deploy.status} · by ${deploy.createdByName} · test level ${deploy.testLevel ?? 'default'}
FAILURES:
${facts.join('\n')}

DEPENDENCY CHECK (against the target org, computed by a program):
${deps.length ? deps.map((d) => `- ${d.kind} ${d.object ? `${d.object}.` : ''}${d.name}: ${d.exists ? 'EXISTS in org' : 'DOES NOT EXIST in org'} (referenced by ${d.referencedBy})`).join('\n') : 'none'}

${code.length ? `CODE CONTEXT — the org's CURRENT version of these classes (the failed deploy was not saved, so the code being deployed may differ):\n${code.map((c) => `--- ${c.className}\n${c.lines}`).join('\n')}` : 'No code context available.'}

Write in Slack mrkdwn: *bold* section titles, "• " bullets, \`names\` in backticks, short code in triple-backtick blocks. No tables, no emoji. Under 300 words. Sections:
*What failed* — one line per failure, in plain language.
*Why* — the root cause; when a dependency DOES NOT EXIST in the org, say the deployment is missing it (or it must be deployed first).
*How to fix* — concrete steps; include a minimal code change when the cause is in code.`;

  try {
    const result = await getLlm().generate({ messages: [{ role: 'user', text: prompt }] });
    return result.text || facts.join('\n');
  } catch (error) {
    console.error(`[DeployWatch] Explanation failed for ${deploy.id}:`, error);
    return facts.join('\n');
  }
}

// Measured from creation, so the clock never jumps back when a queued deploy starts.
export function durationText(d: DeploySnapshot): string {
  const start = d.createdDate;
  const end = d.completedDate ?? new Date().toISOString();
  const sec = Math.max(0, Math.round((new Date(end).getTime() - new Date(start).getTime()) / 1000));
  return sec >= 60 ? `${Math.floor(sec / 60)}m ${String(sec % 60).padStart(2, '0')}s` : `${sec}s`;
}

/** Salesforce only allows quick deploy for validations that ran (and passed) Apex tests. */
export function quickDeployable(d: DeploySnapshot): boolean {
  return d.checkOnly && d.status === 'Succeeded' && d.testsTotal > 0;
}

export function headline(d: DeploySnapshot): string {
  const kind = kindLabel(d);
  switch (d.status) {
    case 'Pending':
      return `:hourglass: *${kind} queued*`;
    case 'InProgress':
    case 'Canceling':
      return `:hourglass_flowing_sand: *${kind} ${d.status === 'Canceling' ? 'canceling' : 'in progress'}* · ${durationText(d)}`;
    case 'Succeeded':
      return `:white_check_mark: *${kind} succeeded* · ${d.componentsTotal} component(s) · ${d.testsTotal} test(s) · ${durationText(d)}${quickDeployable(d) ? ' · ready to quick deploy' : ''}`;
    case 'SucceededPartial':
      return `:warning: *${kind} partially succeeded* · ${d.componentErrors} component error(s) · ${durationText(d)}`;
    case 'Failed':
      return `:x: *${kind} failed* · ${d.componentErrors} component error(s) · ${d.testErrors} test failure(s) · ${durationText(d)}`;
    case 'Canceled':
      return `:no_entry_sign: *${kind} canceled* · ${durationText(d)}`;
  }
}

function bar(done: number, total: number): string {
  if (total <= 0) return '';
  const filled = Math.round((done / total) * 10);
  return `${'▓'.repeat(filled)}${'░'.repeat(10 - filled)} ${done}/${total}`;
}

export function progressLines(d: DeploySnapshot): string[] {
  const lines = [`Components ${bar(d.componentsDeployed, d.componentsTotal) || `${d.componentsDeployed}`}${d.componentErrors ? ` · :x: ${d.componentErrors} error(s)` : ''}`];
  if (d.testsTotal > 0) lines.push(`Tests ${bar(d.testsCompleted, d.testsTotal)}${d.testErrors ? ` · :x: ${d.testErrors} failure(s)` : ''}`);
  if (d.stateDetail && !FINAL_STATUSES.has(d.status)) lines.push(`_${d.stateDetail}_`);
  return lines;
}

// ---------------- Live feed ----------------

export interface FeedEntry {
  ok: boolean;
  label: string;
  at: string;
}

/** Components and tests finished so far, newest first (from checkDeployStatus details). */
export async function fetchLiveFeed(conn: Connection, deployId: string): Promise<{ entries: FeedEntry[]; failures: FeedEntry[] }> {
  const result = (await conn.metadata.checkDeployStatus(deployId, true)) as unknown as {
    details?: {
      componentSuccesses?: unknown;
      componentFailures?: unknown;
      runTestResult?: { successes?: unknown; failures?: unknown };
    };
  };
  const details = result.details ?? {};
  const entries: FeedEntry[] = [];
  for (const c of asArray(details.componentSuccesses as Record<string, unknown>[])) {
    if (!c.componentType || c.fullName === 'package.xml') continue;
    entries.push({ ok: true, label: `${c.componentType} ${c.fullName}`, at: String(c.createdDate ?? '') });
  }
  const failures: FeedEntry[] = [];
  for (const c of asArray(details.componentFailures as Record<string, unknown>[])) {
    const where = c.lineNumber ? ` (line ${c.lineNumber})` : '';
    const entry = { ok: false, label: `${c.componentType || 'Component'} ${c.fullName}${where} — ${String(c.problem || '').slice(0, 90)}`, at: String(c.createdDate ?? '') };
    failures.push(entry);
    entries.push(entry);
  }
  for (const t of asArray(details.runTestResult?.failures as Record<string, unknown>[])) {
    const entry = { ok: false, label: `Test ${t.name}.${t.methodName} — ${String(t.message || '').split('\n')[0].slice(0, 90)}`, at: '' };
    failures.push(entry);
    entries.push(entry);
  }
  for (const t of asArray(details.runTestResult?.successes as Record<string, unknown>[])) {
    entries.push({ ok: true, label: `Test ${t.name}.${t.methodName}`, at: '' });
  }
  entries.sort((a, b) => (b.at || '').localeCompare(a.at || ''));
  return { entries, failures };
}

export function elapsedClock(d: DeploySnapshot): string {
  const start = d.createdDate;
  const end = FINAL_STATUSES.has(d.status) && d.completedDate ? d.completedDate : new Date().toISOString();
  const sec = Math.max(0, Math.round((new Date(end).getTime() - new Date(start).getTime()) / 1000));
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}
