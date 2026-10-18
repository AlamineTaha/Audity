import Anthropic from '@anthropic-ai/sdk';
import { LlmMessage, LlmProvider, LlmRequest, LlmResponse } from './types';

// Models that accept effort tuning and server-side refusal fallbacks ("default" routing).
const FALLBACK_CAPABLE = new Set(['claude-opus-5-5', 'claude-fable-5-1', 'claude-opus-5', 'claude-sonnet-5-5']);

function toMessage(message: LlmMessage, provider: string): Anthropic.Beta.BetaMessageParam {
  switch (message.role) {
    case 'user':
      return { role: 'user', content: message.text };
    case 'assistant': {
      if (message.raw && message.provider === provider) {
        return { role: 'assistant', content: message.raw as Anthropic.Beta.BetaContentBlockParam[] };
      }
      const content: Anthropic.Beta.BetaContentBlockParam[] = [];
      if (message.text) content.push({ type: 'text', text: message.text });
      for (const call of message.toolCalls) {
        content.push({ type: 'tool_use', id: call.id, name: call.name, input: call.args });
      }
      return { role: 'assistant', content };
    }
    case 'tool_results':
      // All results for one turn go in a single user message.
      return {
        role: 'user',
        content: message.results.map((r) => ({
          type: 'tool_result' as const,
          tool_use_id: r.callId,
          content: r.content,
          is_error: r.isError,
        })),
      };
  }
}

export class AnthropicProvider implements LlmProvider {
  readonly name = 'anthropic';
  private client: Anthropic;

  constructor(apiKey: string, readonly model: string) {
    this.client = new Anthropic({ apiKey });
  }

  async generate(req: LlmRequest): Promise<LlmResponse> {
    const capable = FALLBACK_CAPABLE.has(this.model);
    const response = await this.client.beta.messages.create({
      model: this.model,
      max_tokens: req.maxOutputTokens ?? 16000,
      system: req.system,
      messages: req.messages.map((m) => toMessage(m, this.name)),
      tools: req.tools?.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters as Anthropic.Beta.BetaTool.InputSchema,
      })),
      ...(capable
        ? { output_config: { effort: 'medium' as const }, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const }
        : {}),
    });

    if (response.stop_reason === 'refusal') {
      return {
        text: 'The AI model declined to answer this request.',
        toolCalls: [],
        raw: response.content,
        stopReason: 'refusal',
      };
    }

    const text = response.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');
    const toolCalls = response.content
      .filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use')
      .map((b) => ({ id: b.id, name: b.name, args: (b.input ?? {}) as Record<string, unknown> }));

    return { text, toolCalls, raw: response.content, stopReason: response.stop_reason ?? undefined };
  }
}
