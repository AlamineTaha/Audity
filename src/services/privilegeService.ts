/**
 * Privilege escalation monitoring: who effectively holds admin-level system permissions
 * (via profile, permission set, or permission set group), with alerts when that changes.
 */

import type { Connection } from 'jsforce';
import { publishChangeToSlack } from '../slack/alerts';
import { PrivilegedGrantInput, PrivilegedGrantRow } from './databaseService';
import { authService, getDatabase, salesforceService } from './container';

export type PrivilegeSeverity = 'CRITICAL' | 'HIGH' | 'LOW';

export const HIGH_RISK_PERMISSIONS: Record<string, { label: string; severity: 'CRITICAL' | 'HIGH' }> = {
  PermissionsModifyAllData: { label: 'Modify All Data', severity: 'CRITICAL' },
  PermissionsViewAllData: { label: 'View All Data', severity: 'CRITICAL' },
  PermissionsModifyMetadata: { label: 'Modify Metadata Through Metadata API Functions', severity: 'CRITICAL' },
  PermissionsManageProfilesPermissionsets: { label: 'Manage Profiles and Permission Sets', severity: 'CRITICAL' },
  PermissionsAssignPermissionSets: { label: 'Assign Permission Sets', severity: 'CRITICAL' },
  PermissionsManageUsers: { label: 'Manage Users', severity: 'HIGH' },
  PermissionsAuthorApex: { label: 'Author Apex', severity: 'HIGH' },
  PermissionsCustomizeApplication: { label: 'Customize Application', severity: 'HIGH' },
  PermissionsManageSharing: { label: 'Manage Sharing', severity: 'HIGH' },
  PermissionsViewAllUsers: { label: 'View All Users', severity: 'HIGH' },
  PermissionsResetPasswords: { label: 'Reset User Passwords and Unlock Users', severity: 'HIGH' },
  PermissionsManageInternalUsers: { label: 'Manage Internal Users', severity: 'HIGH' },
};

const BASELINE_JOB = 'privileged_access_baseline';
const LAST_RUN_JOB = 'privileged_access_last_run';
const MAX_USERS_IN_ALERT = 15;

export interface RelatedSetupChange {
  display: string;
  action: string;
  createdBy: string;
  createdDate: string;
}

const permissionLabel = (permission: string) => HIGH_RISK_PERMISSIONS[permission]?.label ?? permission.replace(/^Permissions/, '');
const permissionSeverity = (permission: string) => HIGH_RISK_PERMISSIONS[permission]?.severity ?? 'HIGH';
const grantKey = (g: { userId: string; permission: string; sourceType: string; sourceName: string }) =>
  `${g.userId}|${g.permission}|${g.sourceType}|${g.sourceName}`;
const sourceText = (g: PrivilegedGrantInput) =>
  `${g.sourceType === 'Profile' ? 'profile' : g.sourceType === 'PermissionSetGroup' ? 'permission set group' : 'permission set'} \`${g.sourceName}\``;

export function rowToGrant(r: PrivilegedGrantRow): PrivilegedGrantInput {
  return {
    userId: r.user_id,
    userName: r.user_name ?? r.user_id,
    username: r.username ?? '',
    permission: r.permission,
    sourceType: r.source_type,
    sourceName: r.source_name,
  };
}

export function diffGrants(current: PrivilegedGrantInput[], stored: PrivilegedGrantInput[]): {
  added: PrivilegedGrantInput[];
  removed: PrivilegedGrantInput[];
} {
  const currentKeys = new Set(current.map(grantKey));
  const storedKeys = new Set(stored.map(grantKey));
  return {
    added: current.filter((g) => !storedKeys.has(grantKey(g))),
    removed: stored.filter((g) => !currentKeys.has(grantKey(g))),
  };
}

function groupByUser(grants: PrivilegedGrantInput[]): Map<string, PrivilegedGrantInput[]> {
  const byUser = new Map<string, PrivilegedGrantInput[]>();
  for (const g of grants) {
    const list = byUser.get(g.userId) ?? [];
    list.push(g);
    byUser.set(g.userId, list);
  }
  return byUser;
}

function relatedFor(grants: PrivilegedGrantInput[], changes: RelatedSetupChange[]): RelatedSetupChange[] {
  const needles = [grants[0].userName, grants[0].username, ...grants.map((g) => g.sourceName)]
    .filter((n) => n && n.length > 2)
    .map((n) => n.toLowerCase());
  return changes.filter((c) => needles.some((n) => c.display.toLowerCase().includes(n))).slice(0, 3);
}

export function buildPrivilegeAlert(
  added: PrivilegedGrantInput[],
  removed: PrivilegedGrantInput[],
  related: RelatedSetupChange[]
): { text: string; severity: PrivilegeSeverity } {
  const severity: PrivilegeSeverity = added.some((g) => permissionSeverity(g.permission) === 'CRITICAL')
    ? 'CRITICAL'
    : added.length
      ? 'HIGH'
      : 'LOW';

  const lines: string[] = [
    `*[SECURITY] Privileged access changed* · ${added.length} new grant(s)${removed.length ? `, ${removed.length} revoked` : ''}`,
    `*Risk:* ${severity}`,
  ];

  const addedByUser = [...groupByUser(added).values()];
  for (const grants of addedByUser.slice(0, MAX_USERS_IN_ALERT)) {
    const user = grants[0];
    lines.push('', `*${user.userName}*${user.username ? ` (\`${user.username}\`)` : ''}`);
    for (const g of grants) {
      lines.push(`• [${permissionSeverity(g.permission)}] gained *${permissionLabel(g.permission)}* via ${sourceText(g)}`);
    }
    for (const c of relatedFor(grants, related)) {
      lines.push(`  _Setup change:_ "${c.display}" — by ${c.createdBy}, ${new Date(c.createdDate).toUTCString()}`);
    }
  }
  if (addedByUser.length > MAX_USERS_IN_ALERT) {
    lines.push('', `…and ${addedByUser.length - MAX_USERS_IN_ALERT} more user(s). Ask me "who has Modify All Data?" for the full list.`);
  }

  if (removed.length) {
    lines.push('', '*Revoked*');
    for (const g of removed.slice(0, 20)) {
      lines.push(`• [LOW] *${g.userName}* lost *${permissionLabel(g.permission)}* (${sourceText(g)})`);
    }
    if (removed.length > 20) lines.push(`…and ${removed.length - 20} more.`);
  }

  return { text: lines.join('\n'), severity };
}

const soqlString = (value: string) => `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

async function queryAll<T extends Record<string, unknown>>(conn: Connection, soql: string): Promise<T[]> {
  const records: T[] = [];
  let result = await conn.query<T>(soql);
  records.push(...result.records);
  while (!result.done && result.nextRecordsUrl) {
    result = await conn.queryMore<T>(result.nextRecordsUrl);
    records.push(...result.records);
  }
  return records;
}

interface AssignmentRecord extends Record<string, unknown> {
  AssigneeId: string;
  Assignee?: { Name?: string; Username?: string };
  PermissionSetGroupId?: string | null;
  PermissionSetGroup?: { MasterLabel?: string } | null;
  PermissionSet?: Record<string, unknown> & { Label?: string; IsOwnedByProfile?: boolean; Profile?: { Name?: string } | null };
}

export class PrivilegeService {
  private availablePermissions = new Map<string, string[]>();

  /** Permission fields differ by org edition/API version, so only query the ones that exist. */
  private async permissionFields(orgId: string, conn: Connection): Promise<string[]> {
    const cached = this.availablePermissions.get(orgId);
    if (cached) return cached;
    const describe = await conn.sobject('PermissionSet').describe();
    const names = new Set(describe.fields.map((f) => f.name));
    const fields = Object.keys(HIGH_RISK_PERMISSIONS).filter((p) => names.has(p));
    this.availablePermissions.set(orgId, fields);
    return fields;
  }

  /** Live effective grants for active users. `permissions` narrows to specific API field names. */
  async fetchCurrentGrants(orgId: string, permissions?: string[]): Promise<PrivilegedGrantInput[]> {
    const conn = await authService.getConnection(orgId);
    const available = await this.permissionFields(orgId, conn);
    const fields = permissions ? available.filter((p) => permissions.includes(p)) : available;
    if (fields.length === 0) return [];

    const soql =
      'SELECT AssigneeId, Assignee.Name, Assignee.Username, PermissionSetGroupId, PermissionSetGroup.MasterLabel, ' +
      'PermissionSet.Label, PermissionSet.IsOwnedByProfile, PermissionSet.Profile.Name, ' +
      fields.map((f) => `PermissionSet.${f}`).join(', ') +
      ' FROM PermissionSetAssignment WHERE Assignee.IsActive = true AND (' +
      fields.map((f) => `PermissionSet.${f} = true`).join(' OR ') +
      ')';

    const grants = new Map<string, PrivilegedGrantInput>();
    for (const r of await queryAll<AssignmentRecord>(conn, soql)) {
      const ps = r.PermissionSet ?? {};
      const sourceType: PrivilegedGrantInput['sourceType'] = r.PermissionSetGroupId
        ? 'PermissionSetGroup'
        : ps.IsOwnedByProfile
          ? 'Profile'
          : 'PermissionSet';
      const sourceName =
        sourceType === 'PermissionSetGroup'
          ? r.PermissionSetGroup?.MasterLabel ?? r.PermissionSetGroupId ?? 'Unknown group'
          : sourceType === 'Profile'
            ? ps.Profile?.Name ?? ps.Label ?? 'Unknown profile'
            : ps.Label ?? 'Unknown permission set';
      for (const permission of fields) {
        if (ps[permission] !== true) continue;
        const grant: PrivilegedGrantInput = {
          userId: r.AssigneeId,
          userName: r.Assignee?.Name ?? r.AssigneeId,
          username: r.Assignee?.Username ?? '',
          permission,
          sourceType,
          sourceName,
        };
        grants.set(grantKey(grant), grant);
      }
    }
    return [...grants.values()];
  }

  private async fetchRelatedSetupChanges(orgId: string, since: Date): Promise<RelatedSetupChange[]> {
    const conn = await authService.getConnection(orgId);
    const soql =
      'SELECT Action, Display, CreatedDate, CreatedBy.Name FROM SetupAuditTrail ' +
      `WHERE CreatedDate >= ${since.toISOString()} AND (Action LIKE '%PermSet%' OR Action LIKE '%PermissionSet%' ` +
      `OR Action LIKE '%profile%' OR Section = ${soqlString('Manage Users')}) ORDER BY CreatedDate DESC LIMIT 200`;
    const result = await conn.query<{ Action: string; Display?: string; CreatedDate: string; CreatedBy?: { Name?: string } }>(soql);
    return result.records.map((r) => ({
      action: r.Action,
      display: r.Display ?? '',
      createdBy: r.CreatedBy?.Name ?? 'Unknown',
      createdDate: r.CreatedDate,
    }));
  }

  /** Called every monitor cycle. The first run for an org records a baseline without alerting. */
  async check(orgId: string): Promise<void> {
    const db = getDatabase();
    const current = await this.fetchCurrentGrants(orgId);
    const runStartedAt = new Date();

    if (!(await db.getJobState(orgId, BASELINE_JOB))) {
      await db.applyPrivilegedAccessDiff(orgId, current, []);
      await db.setJobState(orgId, BASELINE_JOB, runStartedAt.toISOString());
      await db.setJobState(orgId, LAST_RUN_JOB, runStartedAt.toISOString());
      console.log(`[Privilege] Baseline for ${orgId}: ${current.length} high-risk grant(s)`);
      return;
    }

    const stored = (await db.getPrivilegedAccess(orgId)).map(rowToGrant);
    // Every org has at least one admin; an empty result means the query lost visibility, not that access vanished.
    if (current.length === 0 && stored.length > 0) {
      console.warn(`[Privilege] No high-risk grants returned for ${orgId}; skipping diff (check the integration user's permissions)`);
      return;
    }

    const { added, removed } = diffGrants(current, stored);
    const lastRun = await db.getJobState(orgId, LAST_RUN_JOB);
    await db.applyPrivilegedAccessDiff(orgId, added, removed);
    await db.setJobState(orgId, LAST_RUN_JOB, runStartedAt.toISOString());
    if (added.length === 0 && removed.length === 0) return;

    const since = lastRun ? new Date(new Date(lastRun).getTime() - 5 * 60 * 1000) : new Date(Date.now() - 60 * 60 * 1000);
    let related: RelatedSetupChange[] = [];
    try {
      related = await this.fetchRelatedSetupChanges(orgId, since);
    } catch (error) {
      console.warn(`[Privilege] Could not load related setup changes for ${orgId}:`, error);
    }

    const { text, severity } = buildPrivilegeAlert(added, removed, related);
    console.log(`[Privilege] ${orgId}: ${added.length} added, ${removed.length} removed (${severity})`);
    try {
      if (await publishChangeToSlack(orgId, text, 'privileged-access', 'Security')) return;
    } catch (error) {
      console.error(`[Privilege] Slack delivery failed for ${orgId}, falling back to Salesforce:`, error);
    }
    await salesforceService.publishAuditToSalesforce(orgId, text, 'Privileged access', 'Security');
  }
}

export function resolvePermissionNames(filter?: string): string[] | undefined {
  if (!filter) return undefined;
  const f = filter.toLowerCase().replace(/[^a-z]/g, '');
  const matches = Object.entries(HIGH_RISK_PERMISSIONS)
    .filter(([api, meta]) => api.toLowerCase().includes(f) || meta.label.toLowerCase().replace(/[^a-z]/g, '').includes(f))
    .map(([api]) => api);
  return matches;
}

export { permissionLabel, permissionSeverity };
