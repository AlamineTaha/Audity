/**
 * A single Setup save can write hundreds of audit entries (e.g. field-level security on a
 * permission set). Entries by the same person on the same component, less than SESSION_GAP_MS
 * apart, are one "change session".
 */
export const SESSION_GAP_MS = 15 * 60 * 1000;

export function countSessions(timestamps: number[], gapMs = SESSION_GAP_MS): number {
  if (timestamps.length === 0) return 0;
  const sorted = [...timestamps].sort((a, b) => a - b);
  let sessions = 1;
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] - sorted[i - 1] > gapMs) sessions++;
  }
  return sessions;
}
