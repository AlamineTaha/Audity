/**
 * Setup Audit Trail entries that are system bookkeeping rather than someone changing the org.
 * Shared by insights (hotspots) and, later, the recent-changes noise filter.
 */

export const AUDIT_NOISE = {
  /** Lower-cased action prefixes logged by Salesforce itself (e.g. permission set group recalculation). */
  actionPrefixes: [
    'permissionsetgroupcalculation',
    'permissionselfhealing',
    'permsetgroupstandardchange',
    'owdinternalupdatestarted',
    'owdexternalupdatestarted',
    'recalcsharingrulecomplete',
  ],
  /** Users that represent platform automation, not a person. Matched case-insensitively on the full name. */
  userPatterns: [/^automated process$/i, /^platform integration( user)?$/i, /^system$/i, /^integration user$/i, /^salesforce\.com$/i],
};

export function isAuditNoise(entry: { action?: string | null; createdByName?: string | null }): boolean {
  const action = (entry.action ?? '').toLowerCase();
  if (AUDIT_NOISE.actionPrefixes.some((p) => action.startsWith(p))) return true;
  const user = (entry.createdByName ?? '').trim();
  return user !== '' && AUDIT_NOISE.userPatterns.some((p) => p.test(user));
}
