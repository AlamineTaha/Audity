/**
 * Express Application Setup
 * Configures middleware, routes, and Swagger documentation.
 *
 * Protected routes go through tenantAuth middleware (X-API-Key).
 * Public routes are whitelisted and skip authentication.
 */

import dotenv from 'dotenv';
dotenv.config();

import express, { Express, Request, Response, NextFunction } from 'express';
import cors from 'cors';
import swaggerJsdoc from 'swagger-jsdoc';
import swaggerUi from 'swagger-ui-express';
import agentforceRoutes from './routes/agentforce';
import authRoutes from './routes/auth';
import monitoringRoutes from './routes/monitoring';
import { tenantAuth } from './middleware/tenantAuth';

const app: Express = express();

// ---- Global middleware ----
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use((err: Error, _req: Request, res: Response, next: NextFunction) => {
  if (err instanceof SyntaxError && 'body' in err) {
    res.status(400).json({
      error: 'Invalid JSON in request body',
      details: err.message,
      hint: 'Please check for missing commas, quotes, or brackets in your JSON payload.',
    });
    return;
  }
  next(err);
});

// ---- Endpoints that do NOT require tenant authentication ----
const PUBLIC_PATHS = new Set([
  'GET:/api/v1/health',
  'GET:/api/v1/test-oauth-config',
  'POST:/api/v1/test-gemini',
  'POST:/api/v1/trigger-check',
  'POST:/api/v1/slack-invite',
  'POST:/api/v1/clear-audit-cache',
]);

function conditionalTenantAuth(req: Request, res: Response, next: NextFunction): void {
  const key = `${req.method}:${req.path}`;
  if (PUBLIC_PATHS.has(key)) {
    next();
    return;
  }
  tenantAuth(req, res, next);
}

// ---- Swagger / OpenAPI ----
const swaggerOptions: swaggerJsdoc.Options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'AuditDelta API',
      version: '2.0.0',
      description:
        'Multi-tenant Salesforce automation change monitoring service with AI-powered diff analysis.\n\n' +
        '**Authentication:** All protected endpoints require an `X-API-Key` header. ' +
        'Obtain your API key by completing the OAuth flow at `/auth/authorize`.',
      contact: { name: 'AuditDelta Support' },
    },
    servers: [
      {
        url: process.env.API_BASE_URL || 'http://localhost:3000',
        description: 'Development server',
      },
    ],
    tags: [
      { name: 'Agentforce', description: 'Endpoints for Salesforce Einstein Agent integration' },
      { name: 'Flows', description: 'Flow version management and revert endpoints' },
      { name: 'Auth', description: 'Authentication endpoints (public)' },
      { name: 'Monitoring', description: 'Proactive monitoring and change detection endpoints' },
      { name: 'Security', description: 'Security and permission analysis endpoints' },
    ],
    components: {
      securitySchemes: {
        ApiKeyAuth: {
          type: 'apiKey',
          in: 'header',
          name: 'X-API-Key',
          description: 'API key obtained from /auth/callback after OAuth handshake',
        },
      },
      schemas: {
        AnalyzeFlowRequest: {
          type: 'object',
          required: ['flowName'],
          properties: {
            flowName: { type: 'string', description: 'The API name of the Flow to analyze', example: 'My_Flow' },
          },
        },
        AnalyzeFlowResponse: {
          type: 'object',
          properties: {
            success: { type: 'boolean', example: true },
            flowName: { type: 'string', example: 'My_Flow' },
            summary: { type: 'string' },
            changes: { type: 'array', items: { type: 'string' } },
            error: { type: 'string' },
          },
        },
        AuthCallbackResponse: {
          type: 'object',
          properties: {
            success: { type: 'boolean', example: true },
            orgId: { type: 'string', example: '00D000000000000AAA' },
            apiKey: { type: 'string', description: 'One-time API key. Store securely.' },
            message: { type: 'string' },
          },
        },
        AuthErrorResponse: {
          type: 'object',
          properties: { error: { type: 'string', example: 'Error message' } },
        },
      },
    },
  },
  apis: process.env.NODE_ENV === 'production'
    ? ['./dist/routes/*.js']
    : ['./src/routes/*.ts'],
};

const swaggerSpec = swaggerJsdoc(swaggerOptions);

// ---- Routes ----

// Auth routes are fully public
app.use('/auth', authRoutes);

// Apply conditional tenant auth before API routes
app.use('/api/v1', conditionalTenantAuth);
app.use('/api/v1', agentforceRoutes);
app.use('/api/v1', monitoringRoutes);

// Swagger UI
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));
app.get('/api-docs/swagger.json', (_req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.send(swaggerSpec);
});
app.get('/openapi.json', (_req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.send(swaggerSpec);
});
app.get('/swagger.json', (_req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.send(swaggerSpec);
});

// Root endpoint
app.get('/', (_req, res) => {
  res.json({
    name: 'AuditDelta API',
    version: '2.0.0',
    documentation: '/api-docs',
    health: '/api/v1/health',
    authenticate: '/auth/authorize',
    note: 'All protected endpoints require an X-API-Key header.',
  });
});

export default app;
