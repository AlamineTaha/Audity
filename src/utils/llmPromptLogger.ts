/**
 * LLM Prompt & Response Logger
 * Writes every prompt sent to the LLM and the response received to a file.
 * Use this to debug duplicate Slack messages or understand why certain summaries are generated.
 *
 * Output file: llm_prompts_log.jsonl (project root, append-only, one JSON object per line)
 */

import * as fs from 'fs';
import * as path from 'path';

const LOG_FILE = path.join(process.cwd(), 'llm_prompts_log.jsonl');
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

/**
 * Append a single LLM call to the log file (JSONL format)
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

    // Log path on first write (idempotent - user sees it once per process)
    if (!(logLLMCall as any)._pathLogged) {
      (logLLMCall as any)._pathLogged = true;
      console.log(`[LLM Logger] Prompts & responses logged to: ${LOG_FILE}`);
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
