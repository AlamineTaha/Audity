import { z } from 'zod';
import { auditArchiveService, getDatabase, privilegeService } from '../services/container';
import { HIGH_RISK_PERMISSIONS, permissionLabel, permissionSeverity, resolvePermissionNames } from '../services/privilegeService';
import { defineTool, fail, ok, zInt } from './types';

const MAX_USERS_LISTED = 40;

export const getPrivilegedUsersTool = defineTool({
  name: 'get_privileged_users',
  title: 'List Users With High-Risk Permissions',
  description:
    'Lists active users who currently hold admin-level system permissions (Modify All Data, View All Data, Manage Users, ' +
    'Author Apex, Customize Application, Modify Metadata, Assign Permission Sets, …) and through which profile, permission set ' +
    'or permission set group they get them. Live data from the org. Use for "who has Modify All Data?", "who are our admins?", ' +
    '"who can manage users?" or privilege audits.',
  inputSchema: z.object({
    permission: z
      .string()
      .optional()
      .describe(`Optional permission to filter on, by label or API name, e.g. "Modify All Data" or "PermissionsAuthorApex". Known: ${Object.values(HIGH_RISK_PERMISSIONS).map((p) => p.label).join(', ')}.`),
  }),
  async handler(ctx, { permission }) {
    const filter = resolvePermissionNames(permission);
    if (filter && filter.length === 0) {
      return fail(400, `"${permission}" is not a tracked high-risk permission. Tracked: ${Object.values(HIGH_RISK_PERMISSIONS).map((p) => p.label).join(', ')}.`);
    }
    const grants = await privilegeService.fetchCurrentGrants(ctx.tenant.orgId, filter);

    const users = new Map<string, { name: string; username: string; grants: Array<{ permission: string; label: string; severity: string; source: string }> }>();
    for (const g of grants) {
      const entry = users.get(g.userId) ?? { name: g.userName, username: g.username, grants: [] };
      entry.grants.push({
        permission: g.permission,
        label: permissionLabel(g.permission),
        severity: permissionSeverity(g.permission),
        source: `${g.sourceType}: ${g.sourceName}`,
      });
      users.set(g.userId, entry);
    }
    const list = [...users.entries()]
      .map(([userId, u]) => ({ userId, ...u }))
      .sort((a, b) => b.grants.length - a.grants.length || a.name.localeCompare(b.name));

    const scope = filter ? filter.map(permissionLabel).join(', ') : 'any high-risk permission';
    const lines = list.slice(0, MAX_USERS_LISTED).map((u) => {
      const bySource = new Map<string, string[]>();
      for (const g of u.grants) bySource.set(g.source, [...(bySource.get(g.source) ?? []), g.label]);
      const detail = [...bySource.entries()].map(([source, labels]) => `${labels.join(', ')} (${source})`).join('; ');
      return `• ${u.name}${u.username ? ` <${u.username}>` : ''}: ${detail}`;
    });
    const displayText =
      list.length === 0
        ? `No active user holds ${scope}.`
        : `${list.length} active user(s) hold ${scope}:\n${lines.join('\n')}` +
          (list.length > MAX_USERS_LISTED ? `\n…and ${list.length - MAX_USERS_LISTED} more.` : '');

    return ok({ displayText, permissionFilter: filter ?? null, userCount: list.length, users: list });
  },
});

const isoDate = () =>
  z
    .string()
    .refine((v) => !Number.isNaN(Date.parse(v)), 'must be an ISO date, e.g. 2026-03-01 or 2026-03-01T09:00:00Z');

export const searchAuditHistoryTool = defineTool({
  name: 'search_audit_history',
  title: 'Search Long-Term Audit History',
  description:
    'Searches AuditDelta\'s long-term archive of the Setup Audit Trail (Salesforce itself only keeps 180 days; the archive ' +
    'keeps everything since the org was connected, backfilled with the last 180 days). Prefer this for questions about changes ' +
    'older than a few days, specific dates or months, a specific person, or when free-text search is needed ' +
    '("who changed the Account validation rules in March?", "everything Jane changed on permission sets"). ' +
    'For "what changed in the last N hours" use get_recent_changes instead.',
  inputSchema: z.object({
    query: z.string().optional().describe('Free text matched against the change description, action and section; every word must match.'),
    user: z.string().optional().describe('Name (or part of it) of the person who made the change.'),
    section: z.string().optional().describe('Setup area, e.g. "Manage Users", "Customize Accounts", "Flows".'),
    from: isoDate().optional().describe('Start date/time (ISO 8601), inclusive.'),
    to: isoDate().optional().describe('End date/time (ISO 8601), inclusive. A date without time covers that whole day.'),
    limit: zInt().min(1).max(200).default(50).describe('Maximum entries to return (default 50, max 200).'),
  }),
  async handler(ctx, input) {
    const orgId = ctx.tenant.orgId;
    const db = getDatabase();
    const to = input.to ? new Date(/^\d{4}-\d{2}-\d{2}$/.test(input.to) ? `${input.to}T23:59:59.999Z` : input.to) : undefined;
    const from = input.from ? new Date(input.from) : undefined;

    const [{ rows, total }, stats] = await Promise.all([
      db.searchAuditEvents({ orgId, query: input.query, user: input.user, section: input.section, from, to, limit: input.limit }),
      db.getAuditArchiveStats(orgId),
    ]);

    const backfilling = auditArchiveService.isBackfilling(orgId);
    const coverage = stats.oldest
      ? `Archive covers ${stats.oldest.toISOString().slice(0, 10)} → ${stats.newest?.toISOString().slice(0, 10)} (${stats.count} entries)${backfilling ? '; the 180-day backfill is still running' : ''}.`
      : backfilling
        ? 'The archive is being backfilled with the last 180 days; try again in a few minutes.'
        : 'The archive is empty; it fills on the next monitoring cycle.';

    const lines = rows.map(
      (r) =>
        `• ${r.created_date.toISOString().replace('T', ' ').slice(0, 16)} | ${r.created_by_name ?? 'Unknown'}${r.delegate_user ? ` (as ${r.delegate_user})` : ''} | ${r.section ?? '-'} | ${r.display ?? r.action ?? ''}`
    );
    const displayText =
      total === 0
        ? `No archived setup changes match. ${coverage}`
        : `${total} matching setup change(s)${total > rows.length ? `, showing the newest ${rows.length}` : ''}:\n${lines.join('\n')}\n\n${coverage}`;

    return ok({
      displayText,
      total,
      returned: rows.length,
      archive: { oldest: stats.oldest, newest: stats.newest, count: stats.count, backfilling },
      entries: rows.map((r) => ({
        id: r.id,
        createdDate: r.created_date,
        user: r.created_by_name,
        delegateUser: r.delegate_user,
        section: r.section,
        action: r.action,
        display: r.display,
      })),
    });
  },
});

export const governanceTools = [getPrivilegedUsersTool, searchAuditHistoryTool];
