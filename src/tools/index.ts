import { z } from 'zod';
import { LlmToolSpec } from '../llm';
import { ToolDefinition } from './types';
import { changeTools } from './changes';
import { flowTools } from './flows';
import { flowCompareTools } from './flowCompare';
import { metadataTools } from './metadata';
import { permissionTools } from './permissions';
import { reportTools } from './reports';
import { governanceTools } from './governance';

export const allTools: ToolDefinition[] = [
  ...changeTools,
  ...flowTools,
  ...flowCompareTools,
  ...permissionTools,
  ...metadataTools,
  ...reportTools,
  ...governanceTools,
] as ToolDefinition[];

export function getTool(name: string): ToolDefinition | undefined {
  return allTools.find((t) => t.name === name);
}

// io: 'input' so defaulted fields are optional for the caller.
export function toJsonSchema(tool: ToolDefinition): Record<string, unknown> {
  const schema = z.toJSONSchema(tool.inputSchema, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;
  delete schema.$schema;
  return schema;
}

export function toLlmToolSpecs(tools: ToolDefinition[] = allTools): LlmToolSpec[] {
  return tools.map((t) => ({ name: t.name, description: t.description, parameters: toJsonSchema(t) }));
}
