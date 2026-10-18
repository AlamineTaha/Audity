import { AnthropicProvider } from './anthropic';
import { GeminiProvider } from './gemini';
import { LlmProvider } from './types';

export * from './types';

export function createLlmProvider(): LlmProvider {
  const provider = (process.env.LLM_PROVIDER || 'gemini').toLowerCase();
  switch (provider) {
    case 'gemini':
      return new GeminiProvider(requireEnv('GEMINI_API_KEY'), process.env.GEMINI_MODEL || 'gemini-2.5-flash');
    case 'anthropic':
      return new AnthropicProvider(requireEnv('ANTHROPIC_API_KEY'), process.env.ANTHROPIC_MODEL || 'claude-opus-5-5');
    default:
      throw new Error(`Unsupported LLM_PROVIDER "${provider}" (expected gemini or anthropic)`);
  }
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for LLM_PROVIDER=${process.env.LLM_PROVIDER || 'gemini'}`);
  return value;
}

let shared: LlmProvider | null = null;

/** Process-wide provider, created on first use so the server can boot without AI credentials. */
export function getLlm(): LlmProvider {
  if (!shared) shared = createLlmProvider();
  return shared;
}
