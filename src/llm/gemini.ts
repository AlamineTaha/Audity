import { GoogleGenAI, Content, Part } from '@google/genai';
import { LlmMessage, LlmProvider, LlmRequest, LlmResponse } from './types';

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 3;

function toContent(message: LlmMessage, provider: string): Content {
  switch (message.role) {
    case 'user':
      return { role: 'user', parts: [{ text: message.text }] };
    case 'assistant': {
      if (message.raw && message.provider === provider) return message.raw as Content;
      const parts: Part[] = [];
      if (message.text) parts.push({ text: message.text });
      for (const call of message.toolCalls) {
        parts.push({ functionCall: { id: call.id, name: call.name, args: call.args } });
      }
      return { role: 'model', parts };
    }
    case 'tool_results':
      return {
        role: 'user',
        parts: message.results.map((r) => ({
          functionResponse: {
            id: r.callId,
            name: r.name,
            response: r.isError ? { error: r.content } : { output: r.content },
          },
        })),
      };
  }
}

export class GeminiProvider implements LlmProvider {
  readonly name = 'gemini';
  private client: GoogleGenAI;

  constructor(apiKey: string, readonly model: string) {
    this.client = new GoogleGenAI({ apiKey });
  }

  async generate(req: LlmRequest): Promise<LlmResponse> {
    const contents = req.messages.map((m) => toContent(m, this.name));
    const config = {
      systemInstruction: req.system,
      maxOutputTokens: req.maxOutputTokens,
      responseMimeType: req.json ? 'application/json' : undefined,
      tools: req.tools?.length
        ? [{
            functionDeclarations: req.tools.map((t) => ({
              name: t.name,
              description: t.description,
              parametersJsonSchema: t.parameters,
            })),
          }]
        : undefined,
    };

    for (let attempt = 1; ; attempt++) {
      try {
        const response = await this.client.models.generateContent({ model: this.model, contents, config });
        const candidate = response.candidates?.[0];
        return {
          // Read parts directly: response.text warns whenever function calls are present.
          text: (candidate?.content?.parts ?? [])
            .filter((p) => typeof p.text === 'string' && !p.thought)
            .map((p) => p.text)
            .join(''),
          toolCalls: (response.functionCalls ?? []).map((call, i) => ({
            id: call.id ?? `${call.name}-${i}`,
            name: call.name ?? '',
            args: (call.args ?? {}) as Record<string, unknown>,
          })),
          raw: candidate?.content,
          stopReason: candidate?.finishReason,
        };
      } catch (error) {
        const status = (error as { status?: number }).status;
        if (attempt >= MAX_ATTEMPTS || !status || !RETRYABLE_STATUS.has(status)) throw error;
        await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** (attempt - 1)));
      }
    }
  }
}
