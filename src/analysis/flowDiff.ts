/**
 * Deterministic Flow version diff + security rules. The LLM only explains what this
 * module computes, so changes it reports are never invented or summarized away.
 */

type Json = unknown;
type JsonObject = Record<string, Json>;

export type Severity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';

export interface FieldChange {
  path: string;
  before?: string;
  after?: string;
}

export interface ElementChange {
  type: string;
  name: string;
  change: 'added' | 'removed' | 'modified';
  fields: FieldChange[];
}

export interface Finding {
  severity: Severity;
  rule: string;
  element?: string;
  message: string;
  /** True when the issue does not exist in the previous version. */
  introduced: boolean;
}

export interface FlowDiff {
  flowName: string;
  oldVersion?: number;
  newVersion?: number;
  context: { processType?: string; runInMode?: string; trigger?: string };
  propertyChanges: FieldChange[];
  elements: ElementChange[];
  findings: Finding[];
}

const LAYOUT_KEYS = new Set(['locationX', 'locationY', 'processMetadataValues']);
const IDENTITY_KEYS = ['name', 'field', 'assignToReference', 'leftValueReference'];
const MAX_VALUE_CHARS = 240;
const SEVERITY_ORDER: Severity[] = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];

const isObject = (v: Json): v is JsonObject => typeof v === 'object' && v !== null && !Array.isArray(v);
const asArray = (v: Json): JsonObject[] => (Array.isArray(v) ? v.filter(isObject) : isObject(v) ? [v] : []);

function renderValue(v: Json): string {
  const s = typeof v === 'string' ? JSON.stringify(v) : String(v);
  return s.length > MAX_VALUE_CHARS ? `${s.slice(0, MAX_VALUE_CHARS)}…` : s;
}

function identityOf(item: JsonObject, index: number): string {
  for (const key of IDENTITY_KEYS) {
    if (typeof item[key] === 'string') return String(item[key]);
  }
  return String(index);
}

/** Flattens to path → scalar; arrays of objects are keyed by identity so reordering isn't a change. */
function flatten(value: Json, prefix = '', out: Map<string, string> = new Map()): Map<string, string> {
  if (Array.isArray(value)) {
    value.forEach((item, i) => {
      const key = isObject(item) ? identityOf(item, i) : String(i);
      flatten(item, `${prefix}[${key}]`, out);
    });
  } else if (isObject(value)) {
    for (const [k, v] of Object.entries(value)) {
      if (LAYOUT_KEYS.has(k)) continue;
      flatten(v, prefix ? `${prefix}.${k}` : k, out);
    }
  } else if (value !== null && value !== undefined && value !== '') {
    out.set(prefix, renderValue(value));
  }
  return out;
}

function diffMaps(before: Map<string, string>, after: Map<string, string>): FieldChange[] {
  const changes: FieldChange[] = [];
  for (const [path, value] of after) {
    const old = before.get(path);
    if (old === undefined) changes.push({ path, after: value });
    else if (old !== value) changes.push({ path, before: old, after: value });
  }
  for (const [path, value] of before) {
    if (!after.has(path)) changes.push({ path, before: value });
  }
  return changes;
}

/** Top-level arrays of named objects are element collections (decisions, recordUpdates, …). */
function elementsOf(flow: JsonObject): Map<string, { type: string; el: JsonObject }> {
  const map = new Map<string, { type: string; el: JsonObject }>();
  for (const [type, value] of Object.entries(flow)) {
    if (!Array.isArray(value)) continue;
    for (const el of asArray(value)) {
      if (typeof el.name === 'string') map.set(`${type}:${el.name}`, { type, el });
    }
  }
  if (isObject(flow.start)) map.set('start:start', { type: 'start', el: flow.start });
  return map;
}

function scalarProps(flow: JsonObject): JsonObject {
  const props: JsonObject = {};
  for (const [k, v] of Object.entries(flow)) {
    if (k === 'start' || LAYOUT_KEYS.has(k)) continue;
    if (Array.isArray(v) && asArray(v).some((e) => typeof e.name === 'string')) continue;
    props[k] = v;
  }
  return props;
}

function triggerDescription(flow: JsonObject): string | undefined {
  const start = isObject(flow.start) ? flow.start : undefined;
  if (!start) return undefined;
  const parts = [start.object, start.recordTriggerType, start.triggerType].filter((p) => typeof p === 'string');
  return parts.length ? parts.join(' / ') : undefined;
}

// ---------------- Security & risk rules ----------------

const DML_TYPES = new Set(['recordCreates', 'recordUpdates', 'recordDeletes']);
const PRIVILEGED_OBJECTS = new Set([
  'User', 'PermissionSetAssignment', 'PermissionSetGroup', 'PermissionSetLicenseAssign', 'GroupMember', 'Group',
  'UserRole', 'Profile', 'PermissionSet', 'ObjectPermissions', 'FieldPermissions', 'SetupEntityAccess', 'UserPackageLicense',
]);
const ACCESS_FIELDS = new Set(['ProfileId', 'UserRoleId', 'IsActive', 'OwnerId', 'ManagerId', 'UserType']);
const OUTBOUND_ACTIONS: Record<string, Severity> = {
  externalService: 'HIGH',
  apex: 'MEDIUM',
  emailSimple: 'MEDIUM',
  emailAlert: 'MEDIUM',
  sendEmail: 'MEDIUM',
  chatterPost: 'LOW',
};
const SF_ID_RE = /\b[0a][0-9A-Za-z]{4}0{2,}[0-9A-Za-z]{6,11}\b/g;

function outgoingTargets(el: JsonObject): string[] {
  const targets = new Set<string>();
  const walk = (v: Json, key = '') => {
    if (Array.isArray(v)) v.forEach((x) => walk(x, key));
    else if (isObject(v)) {
      if (/connector$/i.test(key) && typeof v.targetReference === 'string') targets.add(v.targetReference);
      for (const [k, child] of Object.entries(v)) {
        // A loop's exit path leaves the loop body, so it's not followed from the loop itself.
        if (k === 'noMoreValuesConnector') continue;
        walk(child, k);
      }
    }
  };
  walk(el);
  return [...targets];
}

function loopBodyElements(loopName: string, byName: Map<string, { type: string; el: JsonObject }>): string[] {
  const loop = byName.get(loopName);
  const first = isObject(loop?.el.nextValueConnector) ? loop?.el.nextValueConnector.targetReference : undefined;
  if (typeof first !== 'string') return [];
  const seen = new Set<string>();
  const queue = [first];
  while (queue.length) {
    const name = queue.shift() as string;
    if (name === loopName || seen.has(name)) continue;
    seen.add(name);
    const node = byName.get(name);
    if (node) queue.push(...outgoingTargets(node.el));
  }
  return [...seen];
}

function ruleFindings(flow: JsonObject): Omit<Finding, 'introduced'>[] {
  const findings: Omit<Finding, 'introduced'>[] = [];
  const byName = new Map<string, { type: string; el: JsonObject }>();
  for (const { type, el } of elementsOf(flow).values()) {
    if (typeof el.name === 'string') byName.set(el.name, { type, el });
  }
  const systemMode = flow.runInMode === 'SystemModeWithoutSharing';

  if (systemMode) {
    findings.push({
      severity: flow.processType === 'Flow' ? 'HIGH' : 'MEDIUM',
      rule: 'system-mode',
      message:
        flow.processType === 'Flow'
          ? 'Screen flow runs in system mode without sharing: any user (including guest/community users) who can launch it can read and write records they normally cannot see.'
          : 'Flow runs in system mode without sharing, so it ignores record-level access for whoever triggers it.',
    });
  }

  for (const [name, { type, el }] of byName) {
    const object = typeof el.object === 'string' ? el.object : undefined;
    const filters = asArray(el.filters);
    const hasInput = typeof el.inputReference === 'string';

    if ((type === 'recordUpdates' || type === 'recordDeletes') && filters.length === 0 && !hasInput && object) {
      findings.push({
        severity: 'CRITICAL',
        rule: 'unfiltered-dml',
        element: name,
        message: `\`${name}\` ${type === 'recordDeletes' ? 'deletes' : 'updates'} ${object} records with no filter conditions — it affects every ${object} record.`,
      });
    }
    if (type === 'recordDeletes') {
      findings.push({ severity: 'HIGH', rule: 'record-delete', element: name, message: `\`${name}\` permanently deletes ${object ?? 'records'}.` });
    }
    if (DML_TYPES.has(type) && object && PRIVILEGED_OBJECTS.has(object)) {
      findings.push({
        severity: 'CRITICAL',
        rule: 'privilege-object',
        element: name,
        message: `\`${name}\` writes to ${object}, which controls user access — possible privilege escalation${systemMode ? ' (and the flow runs in system mode)' : ''}.`,
      });
    }
    if (type === 'recordUpdates') {
      const touched = asArray(el.inputAssignments).map((a) => a.field).filter((f): f is string => typeof f === 'string');
      const sensitive = touched.filter((f) => ACCESS_FIELDS.has(f));
      if (sensitive.length) {
        findings.push({
          severity: 'HIGH',
          rule: 'access-field',
          element: name,
          message: `\`${name}\` changes access-related field(s) ${sensitive.map((f) => `\`${f}\``).join(', ')} on ${object ?? 'records'}, which changes who can see or act on them.`,
        });
      }
    }
    if ((DML_TYPES.has(type) || type === 'actionCalls' || type === 'apexPluginCalls') && !isObject(el.faultConnector)) {
      findings.push({
        severity: 'MEDIUM',
        rule: 'missing-fault-path',
        element: name,
        message: `\`${name}\` has no fault path: if it fails, the whole transaction rolls back and the user sees an unhandled error.`,
      });
    }
    if (type === 'recordLookups' && filters.length === 0 && object) {
      findings.push({
        severity: 'MEDIUM',
        rule: 'unfiltered-query',
        element: name,
        message: `\`${name}\` queries ${object} with no filter — it reads every record and can hit governor limits as data grows.`,
      });
    }
    if (type === 'actionCalls' && typeof el.actionType === 'string' && OUTBOUND_ACTIONS[el.actionType]) {
      findings.push({
        severity: OUTBOUND_ACTIONS[el.actionType],
        rule: 'outbound-action',
        element: name,
        message: `\`${name}\` runs a ${el.actionType} action (\`${String(el.actionName ?? '')}\`): data can leave the org or code runs outside the flow's control.`,
      });
    }
    if (type === 'variables' && el.isInput === true && systemMode) {
      findings.push({
        severity: 'MEDIUM',
        rule: 'system-mode-input',
        element: name,
        message: `Input variable \`${name}\` can be set by the caller of a system-mode flow — validate it before using it in queries or DML.`,
      });
    }
  }

  for (const [name, { type }] of byName) {
    if (type !== 'loops') continue;
    for (const inner of loopBodyElements(name, byName)) {
      const innerType = byName.get(inner)?.type ?? '';
      if (DML_TYPES.has(innerType) || innerType === 'recordLookups') {
        findings.push({
          severity: 'HIGH',
          rule: 'dml-in-loop',
          element: inner,
          message: `\`${inner}\` (${innerType === 'recordLookups' ? 'query' : 'DML'}) runs inside loop \`${name}\` — one database operation per iteration; this fails governor limits on bulk updates.`,
        });
      }
    }
  }

  const ids = new Set<string>();
  for (const value of flatten(flow).values()) {
    for (const match of value.match(SF_ID_RE) ?? []) {
      if (match.length === 15 || match.length === 18) ids.add(match);
    }
  }
  if (ids.size) {
    findings.push({
      severity: 'MEDIUM',
      rule: 'hardcoded-id',
      message: `Hardcoded record ID(s) ${[...ids].slice(0, 5).map((i) => `\`${i}\``).join(', ')}: IDs differ between sandboxes and production, so this breaks after deployment.`,
    });
  }
  return findings;
}

const findingKey = (f: Omit<Finding, 'introduced'>) => `${f.rule}:${f.element ?? ''}`;

function changeFindings(oldFlow: JsonObject, newFlow: JsonObject, elements: ElementChange[]): Omit<Finding, 'introduced'>[] {
  const findings: Omit<Finding, 'introduced'>[] = [];
  const startChange = elements.find((e) => e.type === 'start' && e.change === 'modified');
  const scopeFields = startChange?.fields.filter((f) => /^(filters|filterFormula|filterLogic|recordTriggerType|triggerType|object|doesRequireRecordChangedToMeetCriteria)/.test(f.path));
  if (scopeFields?.length) {
    findings.push({
      severity: 'MEDIUM',
      rule: 'trigger-scope',
      element: 'start',
      message: `Trigger entry criteria changed (${scopeFields.map((f) => `\`${f.path}\``).join(', ')}): the set of records that fire this flow is different now.`,
    });
  }
  for (const e of elements) {
    if (e.change === 'removed' && e.type === 'customErrors') {
      findings.push({ severity: 'MEDIUM', rule: 'validation-removed', element: e.name, message: `Custom error \`${e.name}\` was removed: records it used to block can now be saved.` });
    }
    if (e.change === 'modified' && e.fields.some((f) => f.path.startsWith('faultConnector') && f.after === undefined)) {
      findings.push({ severity: 'MEDIUM', rule: 'fault-path-removed', element: e.name, message: `The fault path of \`${e.name}\` was removed.` });
    }
  }
  if (oldFlow.runInMode !== newFlow.runInMode && newFlow.runInMode === 'SystemModeWithoutSharing') {
    findings.push({ severity: 'CRITICAL', rule: 'system-mode-enabled', message: `Run mode changed from \`${String(oldFlow.runInMode ?? 'DefaultMode')}\` to \`SystemModeWithoutSharing\` — the flow now bypasses sharing rules.` });
  }
  return findings;
}

/** Key used for flow-level properties (run mode, process type, …) in ownership attribution. */
export const FLOW_PROPERTIES_KEY = 'properties:flow';

export const elementKey = (type: string, name: string) => `${type}:${name}`;

/** `${elementKey}|${path}`; paths match FieldChange.path for that element (or FLOW_PROPERTIES_KEY). */
export const logicFieldKey = (owner: string, path: string) => `${owner}|${path}`;

/**
 * Every meaningful field of a flow (layout excluded), keyed with `logicFieldKey`.
 * Field-level keys let ownership credit a one-word label edit as one field, not a whole element.
 */
export function logicFields(metadata: Json): Set<string> {
  const flow = isObject(metadata) ? metadata : {};
  const fields = new Set<string>();
  for (const { type, el } of elementsOf(flow).values()) {
    const owner = elementKey(type, String(el.name ?? type));
    for (const path of flatten(el).keys()) fields.add(logicFieldKey(owner, path));
  }
  for (const path of flatten(scalarProps(flow)).keys()) fields.add(logicFieldKey(FLOW_PROPERTIES_KEY, path));
  return fields;
}

export function diffFlowVersions(
  oldMetadata: Json,
  newMetadata: Json,
  flowName: string,
  oldVersion?: number,
  newVersion?: number
): FlowDiff {
  const oldFlow = isObject(oldMetadata) ? oldMetadata : {};
  const newFlow = isObject(newMetadata) ? newMetadata : {};

  const propertyChanges = diffMaps(flatten(scalarProps(oldFlow)), flatten(scalarProps(newFlow)));

  const oldEls = elementsOf(oldFlow);
  const newEls = elementsOf(newFlow);
  const elements: ElementChange[] = [];
  for (const [key, { type, el }] of newEls) {
    const prev = oldEls.get(key);
    const name = String(el.name ?? type);
    if (!prev) {
      elements.push({ type, name, change: 'added', fields: diffMaps(new Map(), flatten(el)) });
    } else {
      const fields = diffMaps(flatten(prev.el), flatten(el));
      if (fields.length) elements.push({ type, name, change: 'modified', fields });
    }
  }
  for (const [key, { type, el }] of oldEls) {
    if (!newEls.has(key)) elements.push({ type, name: String(el.name ?? type), change: 'removed', fields: [] });
  }

  const oldKeys = new Set(ruleFindings(oldFlow).map(findingKey));
  const changes = changeFindings(oldFlow, newFlow, elements);
  const changeKeys = new Set(changes.map(findingKey));
  // A change-level finding already says it (e.g. "fault path removed"), so drop the generic duplicate.
  const supersededBy: Record<string, string> = { 'missing-fault-path': 'fault-path-removed', 'system-mode': 'system-mode-enabled' };
  const rules = ruleFindings(newFlow).filter((f) => {
    const parent = supersededBy[f.rule];
    if (!parent) return true;
    const parentKey = parent === 'system-mode-enabled' ? `${parent}:` : `${parent}:${f.element ?? ''}`;
    return !(changeKeys.has(parentKey) && f.severity !== 'HIGH');
  });
  const findings: Finding[] = [
    ...changes.map((f) => ({ ...f, introduced: true })),
    ...rules.map((f) => ({ ...f, introduced: !oldKeys.has(findingKey(f)) })),
  ].sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity) || Number(b.introduced) - Number(a.introduced));

  return {
    flowName,
    oldVersion,
    newVersion,
    context: {
      processType: typeof newFlow.processType === 'string' ? newFlow.processType : undefined,
      runInMode: typeof newFlow.runInMode === 'string' ? newFlow.runInMode : undefined,
      trigger: triggerDescription(newFlow),
    },
    propertyChanges,
    elements,
    findings,
  };
}

export function highestSeverity(findings: Finding[], onlyIntroduced = false): Severity | null {
  const relevant = onlyIntroduced ? findings.filter((f) => f.introduced) : findings;
  for (const s of SEVERITY_ORDER) if (relevant.some((f) => f.severity === s)) return s;
  return null;
}

const MAX_FIELDS_PER_ELEMENT = 30;

/** Compact, line-oriented rendering used both as LLM input and as the `changes` list. */
export function renderDiffLines(diff: FlowDiff): string[] {
  const lines: string[] = [];
  const field = (f: FieldChange) =>
    f.before === undefined ? `${f.path} = ${f.after}` : f.after === undefined ? `${f.path} removed (was ${f.before})` : `${f.path}: ${f.before} → ${f.after}`;

  for (const p of diff.propertyChanges) lines.push(`~ flow property ${field(p)}`);
  for (const e of diff.elements) {
    if (e.change === 'removed') {
      lines.push(`- removed ${e.type} "${e.name}"`);
      continue;
    }
    // Identity fields repeat what the header or the [key] in the path already says.
    const meaningful = e.fields.filter((f) => {
      if (e.change === 'added' && f.path === 'name') return false;
      const m = f.path.match(/\[([^\]]+)\]\.(name|field|assignToReference|leftValueReference)$/);
      return !(m && f.after === JSON.stringify(m[1]) && f.before === undefined);
    });
    const shown = meaningful.slice(0, MAX_FIELDS_PER_ELEMENT).map(field);
    const more = meaningful.length > MAX_FIELDS_PER_ELEMENT ? ` (+${meaningful.length - MAX_FIELDS_PER_ELEMENT} more fields)` : '';
    lines.push(`${e.change === 'added' ? '+ added' : '~ modified'} ${e.type} "${e.name}": ${shown.join('; ')}${more}`);
  }
  return lines;
}

export function renderFindingLines(findings: Finding[]): string[] {
  return findings.map((f) => `[${f.severity}]${f.introduced ? '[introduced]' : '[pre-existing]'} ${f.message}`);
}
