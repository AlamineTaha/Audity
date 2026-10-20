import crypto from 'crypto';
import { getLlm, LlmMessage, LlmToolResult } from '../llm';
import { authService } from '../services/container';
import { allTools, getTool, toLlmToolSpecs } from '../tools';
import { ToolContext, ToolImage } from '../tools/types';
import { TenantContext } from '../types';

const MAX_STEPS = 6;
const MAX_TOOL_RESULT_CHARS = 12000;
const CONVERSATION_TTL_SEC = 24 * 60 * 60;
const PENDING_ACTION_TTL_SEC = 60 * 60;

export interface PendingAction {
  id: string;
  orgId: string;
  toolName: string;
  args: Record<string, unknown>;
  requestedBy: string;
}

export interface AgentReply {
  text: string;
  pendingActions: PendingAction[];
  /** Charts produced by tools this turn; posted to Slack, never stored in the LLM history. */
  images: ToolImage[];
}

const conversationKey = (teamId: string, channel: string, threadTs: string) =>
  `slack_conv:${teamId}:${channel}:${threadTs}`;

export async function loadConversation(teamId: string, channel: string, threadTs: string): Promise<LlmMessage[]> {
  const raw = await authService.getCachedValue(conversationKey(teamId, channel, threadTs));
  return raw ? (JSON.parse(raw) as LlmMessage[]) : [];
}

export async function saveConversation(teamId: string, channel: string, threadTs: string, messages: LlmMessage[]): Promise<void> {
  await authService.setCachedValue(conversationKey(teamId, channel, threadTs), JSON.stringify(messages), CONVERSATION_TTL_SEC);
}

export async function savePendingAction(action: PendingAction): Promise<void> {
  await authService.setCachedValue(`slack_action:${action.id}`, JSON.stringify(action), PENDING_ACTION_TTL_SEC);
}

/** Returns and deletes the action, so a confirmation button can only fire once. */
export async function takePendingAction(id: string): Promise<PendingAction | null> {
  const key = `slack_action:${id}`;
  const raw = await authService.getCachedValue(key);
  if (!raw) return null;
  await authService.deleteCachedValue(key);
  return JSON.parse(raw) as PendingAction;
}

function systemPrompt(tenant: TenantContext): string {
  return [
    `You are AuditDelta, a Salesforce configuration-governance assistant working inside Slack for the team that administers the Salesforce org ${tenant.orgId} (${tenant.instanceUrl}).`,
    'Answer from tool results, never from assumptions about the org. If no tool can answer, say so.',
    'The audit trail only says that a Flow version was created or activated. Whenever a Flow change is involved, call analyze_flow_changes (latest change) or compare_flow_versions (specific versions) for that Flow and report the element-level diff and its security findings — never describe a Flow change from the audit trail alone.',
    'Write for Slack: lead with the answer in one or two sentences, then short bullets. Use Markdown. Mention risk explicitly when you see it (hardcoded IDs, DML in loops, broad permissions such as Modify All Data).',
    'Tools that change the org (activating or reverting a Flow version) are never run directly: when you call one, the user gets Confirm/Cancel buttons. After calling it, tell the user what will happen and that they need to confirm.',
  ].join('\n');
}

function serializeResult(body: Record<string, unknown>): string {
  const { displayText, ...data } = body;
  const text = `${displayText ?? ''}\n\nDATA: ${JSON.stringify(data)}`;
  return text.length > MAX_TOOL_RESULT_CHARS ? `${text.slice(0, MAX_TOOL_RESULT_CHARS)}… [truncated]` : text;
}

async function runToolWithImages(
  ctx: ToolContext,
  name: string,
  args: Record<string, unknown>
): Promise<{ body: Record<string, unknown>; images: ToolImage[] }> {
  const tool = getTool(name);
  if (!tool) return { body: { success: false, error: `Unknown tool ${name}` }, images: [] };
  const parsed = tool.inputSchema.safeParse(args);
  if (!parsed.success) return { body: { success: false, error: `Invalid arguments: ${parsed.error.message}` }, images: [] };
  try {
    const result = await tool.handler(ctx, parsed.data);
    return { body: result.body, images: result.images ?? [] };
  } catch (error) {
    console.error(`[SlackAgent] Tool ${name} failed:`, error);
    return { body: { success: false, error: error instanceof Error ? error.message : 'Tool failed' }, images: [] };
  }
}

export async function runTool(ctx: ToolContext, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  return (await runToolWithImages(ctx, name, args)).body;
}

/** Appends the user's message to `history` (mutated in place) and runs the tool loop. */
export async function runAgent(
  tenant: TenantContext,
  history: LlmMessage[],
  userText: string,
  userId: string,
  baseUrl: string
): Promise<AgentReply> {
  const llm = getLlm();
  const tools = toLlmToolSpecs(allTools);
  const ctx: ToolContext = { tenant, source: 'slack', actor: userId, baseUrl };
  const pendingActions: PendingAction[] = [];
  const images: ToolImage[] = [];

  history.push({ role: 'user', text: userText });

  for (let step = 0; step < MAX_STEPS; step++) {
    const response = await llm.generate({ system: systemPrompt(tenant), messages: history, tools });
    history.push({ role: 'assistant', text: response.text, toolCalls: response.toolCalls, raw: response.raw, provider: llm.name });

    if (response.toolCalls.length === 0) {
      return { text: response.text || 'I could not produce an answer.', pendingActions, images };
    }

    const results: LlmToolResult[] = await Promise.all(
      response.toolCalls.map(async (call) => {
        const tool = getTool(call.name);
        if (tool?.mutating) {
          const action: PendingAction = {
            id: crypto.randomUUID(),
            orgId: tenant.orgId,
            toolName: call.name,
            args: call.args,
            requestedBy: userId,
          };
          await savePendingAction(action);
          pendingActions.push(action);
          return {
            callId: call.id,
            name: call.name,
            content: 'Not executed yet: the user has been shown Confirm/Cancel buttons in Slack. Do not call this tool again.',
          };
        }
        const { body, images: toolImages } = await runToolWithImages(ctx, call.name, call.args);
        images.push(...toolImages);
        const chartNote = toolImages.length ? `\n\n[${toolImages.length} chart(s) will be posted with your answer: ${toolImages.map((i) => i.title).join('; ')}]` : '';
        return { callId: call.id, name: call.name, content: serializeResult(body) + chartNote, isError: body.success === false };
      })
    );
    history.push({ role: 'tool_results', results });
  }

  return {
    text: 'This needed more steps than I allow in one turn. Try a narrower question.',
    pendingActions,
    images,
  };
}
