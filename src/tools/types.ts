import { z } from 'zod';
import { TenantContext } from '../types';

export interface ToolContext {
  tenant: TenantContext;
  source: 'rest' | 'mcp' | 'slack';
  /** Human-readable identity of the caller (Slack user, MCP client), for audit logs. */
  actor?: string;
  /** Public base URL of this server, for building download links. */
  baseUrl: string;
}

export interface ToolResultBody {
  success: boolean;
  /** Ready-to-show summary; every surface (REST, MCP, Slack) relies on it. */
  displayText?: string;
  error?: string;
  [key: string]: unknown;
}

export interface ToolResult {
  /** HTTP status for the REST surface; defaults to 200 (or 500 when success=false and unset). */
  status?: number;
  body: ToolResultBody;
}

export interface ToolDefinition<S extends z.ZodObject = z.ZodObject> {
  /** snake_case; used as the MCP tool name and LLM function name. */
  name: string;
  title: string;
  /** Written for an LLM: what it does and when to use it. */
  description: string;
  inputSchema: S;
  /** Changes org state; Slack asks the user to confirm before running it. */
  mutating?: boolean;
  handler(ctx: ToolContext, input: z.infer<S>): Promise<ToolResult>;
}

export function defineTool<S extends z.ZodObject>(def: ToolDefinition<S>): ToolDefinition<S> {
  return def;
}

export function ok(body: Omit<ToolResultBody, 'success'>): ToolResult {
  return { body: { success: true, ...body } };
}

export function fail(status: number, error: string, extra: Record<string, unknown> = {}): ToolResult {
  return { status, body: { success: false, error, displayText: error, ...extra } };
}

// REST passes query-string values as strings, so numbers/booleans must accept both forms.
export const zInt = () => z.coerce.number().int();
export const zBool = () =>
  z.preprocess((v) => (v === 'true' ? true : v === 'false' ? false : v), z.boolean());
