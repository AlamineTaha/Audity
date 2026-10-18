import { Request, Response, RequestHandler } from 'express';
import { z } from 'zod';
import { AuthenticatedRequest } from '../types';
import { ToolDefinition } from './types';

export function toolRoute(tool: ToolDefinition): RequestHandler {
  return async (req: Request, res: Response) => {
    const raw = { ...(req.body ?? {}), ...(req.query as Record<string, unknown>) };
    const parsed = tool.inputSchema.safeParse(raw);
    if (!parsed.success) {
      const message = z.prettifyError(parsed.error);
      res.status(400).json({ success: false, error: message, displayText: message });
      return;
    }
    try {
      const { tenant } = req as AuthenticatedRequest;
      const baseUrl = process.env.API_BASE_URL || `${req.protocol}://${req.get('host')}`;
      const result = await tool.handler({ tenant, source: 'rest', baseUrl }, parsed.data);
      res.status(result.status ?? (result.body.success ? 200 : 500)).json(result.body);
    } catch (error) {
      console.error(`[Tool:${tool.name}] Unhandled error:`, error);
      const message = error instanceof Error ? error.message : 'Internal server error';
      res.status(500).json({ success: false, error: message, displayText: message });
    }
  };
}
