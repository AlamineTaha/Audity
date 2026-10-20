import { Router, Request, Response } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { allTools } from '../tools';
import { TenantContext } from '../types';
import { authenticateBearer } from './oauth';

function buildServer(tenant: TenantContext, baseUrl: string): McpServer {
  const server = new McpServer(
    { name: 'auditdelta', version: '1.0.0' },
    {
      instructions:
        'AuditDelta audits Salesforce org configuration changes (Flows, permissions, validation rules, fields). ' +
        'Each tool result starts with a human-readable summary you can show to the user as-is.',
    }
  );

  for (const tool of allTools) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: { readOnlyHint: !tool.mutating, destructiveHint: Boolean(tool.mutating), openWorldHint: true },
      },
      async (args: unknown) => {
        const result = await tool.handler({ tenant, source: 'mcp', baseUrl, actor: 'mcp' }, args as never);
        const { displayText, ...data } = result.body;
        return {
          content: [
            { type: 'text' as const, text: displayText ?? result.body.error ?? 'Done.' },
            { type: 'text' as const, text: JSON.stringify(data) },
            ...(result.images ?? []).map((img) => ({ type: 'image' as const, data: img.png.toString('base64'), mimeType: 'image/png' })),
          ],
          isError: !result.body.success,
        };
      }
    );
  }
  return server;
}

const router = Router();

// Stateless streamable HTTP: a fresh server per request, JSON responses (no SSE session).
router.post('/mcp', async (req: Request, res: Response) => {
  const auth = await authenticateBearer(req);
  if (!auth.ok) {
    res
      .status(auth.status)
      .set('WWW-Authenticate', 'Bearer')
      .json({ jsonrpc: '2.0', error: { code: -32000, message: auth.error }, id: null });
    return;
  }

  const baseUrl = process.env.API_BASE_URL || `${req.protocol}://${req.get('host')}`;
  const server = buildServer(auth.tenant, baseUrl);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => {
    void transport.close();
    void server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error('[MCP] Request failed:', error);
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
    }
  }
});

router.all('/mcp', (_req: Request, res: Response) => {
  res.status(405).set('Allow', 'POST').json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null });
});

export default router;
