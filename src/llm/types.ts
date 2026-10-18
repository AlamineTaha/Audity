export type JsonSchema = Record<string, unknown>;

export interface LlmToolSpec {
  name: string;
  description: string;
  parameters: JsonSchema;
}

export interface LlmToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface LlmToolResult {
  callId: string;
  name: string;
  content: string;
  isError?: boolean;
}

export type LlmMessage =
  | { role: 'user'; text: string }
  /** `raw` is the provider-native content; replaying it keeps thinking/signature blocks intact. */
  | { role: 'assistant'; text: string; toolCalls: LlmToolCall[]; raw?: unknown; provider?: string }
  | { role: 'tool_results'; results: LlmToolResult[] };

export interface LlmRequest {
  system?: string;
  messages: LlmMessage[];
  tools?: LlmToolSpec[];
  maxOutputTokens?: number;
  /** Ask for a JSON-only response where the provider supports it. */
  json?: boolean;
}

export interface LlmResponse {
  text: string;
  toolCalls: LlmToolCall[];
  raw: unknown;
  stopReason?: string;
}

export interface LlmProvider {
  readonly name: string;
  readonly model: string;
  generate(req: LlmRequest): Promise<LlmResponse>;
}
