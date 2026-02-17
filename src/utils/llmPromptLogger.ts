/**
 * LLM Prompt & Response Logger
 * Writes every prompt sent to the LLM and the response received.
 * 1. Appends to llm_prompts_log.jsonl (project root)
 * 2. Writes each prompt to its own file in llm_prompts_log/{Flows|schema|security}/
 *
 * Use this to debug duplicate Slack messages or understand why certain summaries are generated.
 */

import * as fs from 'fs';
import * as path from 'path';

const LOG_FILE = path.join(process.cwd(), 'llm_prompts_log.jsonl');
const LOG_DIR = path.join(process.cwd(), 'llm_prompts_log');
const MAX_LOG_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB - rotate if larger

export interface LLMCallLog {
  timestamp: string;
  method: string;
  context?: string;
  prompt: string;
  response: string;
  promptLength: number;
  responseLength: number;
}

/** Map method to folder: Flows, schema, or security */
function getFolderForMethod(method: string): string {
  if (method === 'generateSummary' || method === 'analyzeDevelopmentSession') return 'Flows';
  if (method === 'interpretUnmappedAction') return 'security';
  return 'schema';
}

/** Sanitize string for use in filename */
function sanitizeForFilename(s: string): string {
  return s.replace(/[:/\\?*"<>|]/g, '_');
}

/**
 * Append a single LLM call to the log file (JSONL format) and write individual file
 */
export function logLLMCall(entry: LLMCallLog): void {
  try {
    const line = JSON.stringify(entry) + '\n';

    // Rotate if file is too large
    if (fs.existsSync(LOG_FILE)) {
      const stat = fs.statSync(LOG_FILE);
      if (stat.size > MAX_LOG_SIZE_BYTES) {
        const backupPath = LOG_FILE.replace('.jsonl', `.${Date.now()}.jsonl.bak`);
        fs.renameSync(LOG_FILE, backupPath);
        console.log(`[LLM Logger] Rotated log to ${path.basename(backupPath)}`);
      }
    }

    fs.appendFileSync(LOG_FILE, line, 'utf8');

    // Write individual file per prompt
    const folder = getFolderForMethod(entry.method);
    const dir = path.join(LOG_DIR, folder);
    const ts = sanitizeForFilename(entry.timestamp);
    const method = sanitizeForFilename(entry.method);
    const filename = `${ts}_${method}.json`;
    const filePath = path.join(dir, filename);

    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(filePath, JSON.stringify(entry, null, 2), 'utf8');

    // Log path on first write (idempotent - user sees it once per process)
    if (!(logLLMCall as any)._pathLogged) {
      (logLLMCall as any)._pathLogged = true;
      console.log(`[LLM Logger] Prompts & responses logged to: ${LOG_FILE} and ${LOG_DIR}/`);
    }
  } catch (err) {
    console.error('[LLM Logger] Failed to write log:', err);
  }
}

/**
 * Get the path to the current log file (for user reference)
 */
export function getLogFilePath(): string {
  return LOG_FILE;
}
