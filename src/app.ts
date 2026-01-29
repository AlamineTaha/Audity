/**
 * Express Application Setup
 * Configures middleware, routes, and Swagger documentation
 */

import dotenv from 'dotenv';
// Load environment variables FIRST, before importing routes that use them
dotenv.config();

import express, { Express } from 'express';
import cors from 'cors';
import swaggerJsdoc from 'swagger-jsdoc';
import swaggerUi from 'swagger-ui-express';
import agentforceRoutes from './routes/agentforce';
import authRoutes from './routes/auth';
import monitoringRoutes from './routes/monitoring';

const app: Express = express();

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Error handling middleware for JSON parsing errors
app.use((err: Error, _req: express.Request, res: express.Response, next: express.NextFunction) => {
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

// Swagger/OpenAPI configuration
const swaggerOptions: swaggerJsdoc.Options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'AuditDelta API',
      version: '1.0.0',
      description:
        'Salesforce automation change monitoring service with AI-powered diff analysis. This API is designed for integration with Salesforce Einstein Agentforce.',
      contact: {
        name: 'AuditDelta Support',
      },
    },
    servers: [
      {
        url: process.env.API_BASE_URL || 'http://localhost:3000',
        description: 'Development server',
      },
    ],
    tags: [
      {
        name: 'Agentforce',
        description: 'Endpoints for Salesforce Einstein Agent integration',
      },
      {
        name: 'Flows',
        description: 'Flow version management and revert endpoints',
      },
      {
        name: 'Auth',
        description: 'Authentication endpoints',
      },
      {
        name: 'Monitoring',
        description: 'Proactive monitoring and change detection endpoints',
      },
      {
        name: 'Security',
        description: 'Security and permission analysis endpoints',
      },
    ],
    components: {
      schemas: {
        AnalyzeFlowRequest: {
          type: 'object',
          required: ['flowName', 'orgId'],
          properties: {
            flowName: {
              type: 'string',
              description: 'The API name of the Flow to analyze',
              example: 'My_Flow',
            },
            orgId: {
              type: 'string',
              description: 'The Salesforce Organization ID',
              example: '00D000000000000AAA',
            },
          },
        },
        AnalyzeFlowResponse: {
          type: 'object',
          properties: {
            success: {
              type: 'boolean',
              example: true,
            },
            flowName: {
              type: 'string',
              example: 'My_Flow',
            },
            summary: {
              type: 'string',
              example: 'The Flow was updated to include a new decision element...',
            },
            changes: {
              type: 'array',
              items: {
                type: 'string',
              },
              example: ['Added new decision element', 'Modified field update logic'],
            },
            error: {
              type: 'string',
              example: 'Error message if success is false',
            },
          },
        },
        AuthCallbackResponse: {
          type: 'object',
          properties: {
            success: {
              type: 'boolean',
              example: true,
            },
            orgId: {
              type: 'string',
              description: 'Salesforce Organization ID',
              example: '00D000000000000AAA',
            },
            message: {
              type: 'string',
              example: 'Organization successfully authenticated',
            },
          },
        },
        AuthErrorResponse: {
          type: 'object',
          properties: {
            error: {
              type: 'string',
              example: 'Error message',
            },
          },
        },
      },
    },
    paths: {
      '/api/v1/trigger-check': {
        post: {
          summary: 'Force Immediate Change Check',
          description: 'Manually triggers the polling engine to check for Salesforce changes immediately, analyze them with AI, and send Slack alerts if issues are found.',
          operationId: 'triggerCheck',
          tags: ['Monitoring'],
          responses: {
            '200': {
              description: 'Check initiated',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      success: { type: 'boolean' },
                      message: { type: 'string', example: 'Manual check initiated. Notifications will be sent if changes are found.' },
                    },
                  },
                },
              },
            },
          },
        },
      },
      '/api/v1/recent-changes': {
        get: {
          summary: 'Get Recent Org Activity',
          description: 'Retrieves a raw list of metadata changes (Flows, Permissions, Objects) from the Audit Trail.',
          operationId: 'getRecentChanges',
          tags: ['Monitoring'],
          parameters: [
            {
              in: 'query',
              name: 'hours',
              schema: { type: 'integer', default: 24 },
              description: 'Lookback window in hours',
            },
          ],
          responses: {
            '200': {
              description: 'List of recent changes',
              content: {
                'application/json': {
                  schema: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        action: { type: 'string', example: 'ChangedFlow' },
                        user: { type: 'string', example: 'Alice Smith' },
                        section: { type: 'string', example: 'Flow Management' },
                        timestamp: { type: 'string' },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
      '/api/v1/analyze-permission': {
        post: {
          summary: 'Trace User Permissions',
          description: 'Analyzes a specific user\'s System Permissions. Traces exactly which Profile or Permission Set grants a permission. Supports natural language queries (e.g., "create report", "export reports") or exact API names (e.g., "PermissionsCreateReport"). Note: Currently only supports System Permissions (not Object/Field permissions).',
          operationId: 'analyzePermission',
          tags: ['Security'],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['userId', 'orgId'],
                  properties: {
                    userId: { 
                      type: 'string', 
                      description: 'Salesforce User ID (18-character) or Username (email)',
                      example: '005J6000002RB2uIAG',
                    },
                    orgId: { 
                      type: 'string', 
                      description: 'Salesforce Organization ID',
                      example: '00DJ6000001H7etMAC',
                    },
                    permissionName: { 
                      type: 'string', 
                      description: 'System Permission to check. Supports natural language (e.g., "create report", "export reports") or exact API name (e.g., "PermissionsCreateReport"). If not provided, returns basic user info.',
                      example: 'create report',
                    },
                  },
                },
              },
            },
          },
          responses: {
            '200': {
              description: 'Permission analysis result',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      username: { 
                        type: 'string',
                        description: 'User\'s full name',
                        example: 'Alice Smith',
                      },
                      userId: { 
                        type: 'string',
                        description: 'Salesforce User ID',
                        example: '005J6000002RB2uIAG',
                      },
                      checkingPermission: { 
                        type: 'string',
                        description: 'The resolved API name of the permission checked',
                        example: 'PermissionsCreateReport',
                      },
                      hasAccess: { 
                        type: 'boolean',
                        description: 'Whether the user has the requested permission',
                        example: true,
                      },
                      sources: { 
                        type: 'array',
                        description: 'List of Profiles/Permission Sets that grant this permission',
                        items: { type: 'string' },
                        example: ['Profile: System Administrator', 'Permission Set: Marketing Manager'],
                      },
                      explanation: { 
                        type: 'string',
                        description: 'Human-readable explanation of the permission analysis',
                        example: 'User can do this because it is granted by: Profile: System Administrator, Permission Set: Marketing Manager',
                      },
                    },
                  },
                },
              },
            },
            '400': {
              description: 'Bad request - missing required fields or invalid JSON',
            },
            '404': {
              description: 'User not found',
            },
            '500': {
              description: 'Internal server error',
            },
          },
        },
      },
    },
  },
  apis: ['./src/routes/*.ts'], // Path to the API files
};

const swaggerSpec = swaggerJsdoc(swaggerOptions);

// Routes
app.use('/api/v1', agentforceRoutes);
app.use('/api/v1', monitoringRoutes);
app.use('/auth', authRoutes);

// Swagger UI
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));

// Swagger UI
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));

// Expose OpenAPI JSON spec for download
app.get('/api-docs/swagger.json', (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.send(swaggerSpec);
});

app.get('/openapi.json', (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.send(swaggerSpec);
});

// Expose OpenAPI JSON spec at root level
app.get('/openapi.json', (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.send(swaggerSpec);
  });
  
  app.get('/swagger.json', (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.send(swaggerSpec);
  });
  
  // Swagger UI
  app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));
// Root endpoint
app.get('/', (req, res) => {
  res.json({
    name: 'AuditDelta API',
    version: '1.0.0',
    documentation: '/api-docs',
    health: '/api/v1/health',
  });
});

export default app;

