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
          description: "Analyzes a specific user's permissions. Useful for Agentforce to answer 'Why can User X do Y?'.",
          operationId: 'analyzePermission',
          tags: ['Security'],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['userId'],
                  properties: {
                    userId: { type: 'string', description: 'Salesforce User ID or Username' },
                    permissionName: { type: 'string', description: 'Optional: Specific permission api name to check' },
                  },
                },
              },
            },
          },
          responses: {
            '200': {
              description: 'Analysis result',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      username: { type: 'string' },
                      permissionSets: { type: 'integer' },
                      riskAnalysis: { type: 'string' },
                    },
                  },
                },
              },
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

