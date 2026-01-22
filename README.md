# AuditDelta

A production-ready Node.js (TypeScript) middleware application that monitors Salesforce Orgs for automation changes (Flows/CMS), uses Generative AI to explain logic differences, alerts Slack, and exposes an API for Salesforce Agentforce integration.

## Features

- 🔍 **Real-time Monitoring**: Automated polling of Salesforce SetupAuditTrail for Flow and CMS changes
- 🤖 **AI-Powered Analysis**: Uses Google Gemini/Vertex AI to generate human-readable summaries of changes
- 💰 **Flexible Billing**: Supports both Personal (API Key) and Enterprise (Vertex AI with customer billing) modes
- 🔐 **OAuth 2.0 Authentication**: Secure Salesforce authentication with automatic token refresh
- 📊 **Agentforce Integration**: REST API with OpenAPI/Swagger documentation for Einstein Agent queries
- 🔔 **Slack Notifications**: Block Kit formatted alerts for detected changes
- 🚫 **No Local Git**: Fetches metadata directly from Salesforce (Tooling API & Connect API)

## Architecture

### Key Components

1. **Auth Service** (`src/services/authService.ts`)
   - OAuth 2.0 Web Server Flow
   - Redis-based token storage
   - Automatic token refresh

2. **AI Service** (`src/services/aiService.ts`)
   - Gemini API (Personal billing)
   - Vertex AI (Enterprise billing with `X-Goog-User-Project` header)
   - JSON sanitization (removes visual noise)

3. **Salesforce Service** (`src/services/salesforceService.ts`)
   - Tooling API queries for Flow metadata
   - Connect API for CMS content
   - Version comparison logic

4. **Polling Service** (`src/services/pollingService.ts`)
   - Scheduled checks via `node-cron`
   - Processes audit trail records
   - Triggers AI analysis and Slack notifications

5. **Agentforce API** (`src/routes/agentforce.ts`)
   - `POST /api/v1/analyze-flow` - On-demand Flow analysis
   - OpenAPI 3.0 specification for Salesforce integration

## Setup

### Prerequisites

- Node.js 18+ and npm
- Redis server
- Salesforce Connected App (for OAuth)
- Google Gemini API Key or Vertex AI access

### Installation

```bash
# Install dependencies
npm install

# Copy environment variables
cp .env.example .env

# Edit .env with your configuration
```

### Environment Variables

```env
# Server
PORT=3000
NODE_ENV=development

# Redis
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=

# Salesforce OAuth
SF_CLIENT_ID=your_client_id
SF_CLIENT_SECRET=your_client_secret
SF_REDIRECT_URI=http://localhost:3000/auth/callback
SF_LOGIN_URL=https://login.salesforce.com

# AI Service
GEMINI_API_KEY=your_gemini_api_key
GEMINI_MODEL=gemini-2.5-flash
# Options: gemini-2.5-flash (latest, best price-performance) or gemini-2.5-pro (powerful reasoning)
# Note: gemini-1.5-flash and gemini-1.5-pro are deprecated/not available
VERTEX_AI_ENDPOINT=https://us-central1-aiplatform.googleapis.com/v1/projects
VERTEX_AI_REGION=us-central1

# Slack
SLACK_WEBHOOK_URL=your_slack_webhook_url

# Enterprise Billing (optional)
USER_GCP_PROJECT_ID=your_gcp_project_id
```

### Build & Run

```bash
# Development
npm run dev

# Production
npm run build
npm start
```

## Usage

### 1. Authenticate a Salesforce Org

```bash
# Initiate OAuth flow (Personal billing)
GET /auth/authorize?billingMode=PERSONAL

# Initiate OAuth flow (Enterprise billing)
GET /auth/authorize?billingMode=ENTERPRISE&gcpProjectId=your-project-id
```

After OAuth callback, the org is registered and polling begins automatically.

### 2. Query Flow Changes (Agentforce)

```bash
POST /api/v1/analyze-flow
Content-Type: application/json

{
  "flowName": "My_Flow",
  "orgId": "00D000000000000AAA"
}
```

Response:
```json
{
  "success": true,
  "flowName": "My_Flow",
  "summary": "The Flow was updated to include a new decision element...",
  "changes": [
    "Added new decision element",
    "Modified field update logic"
  ]
}
```

### 3. API Documentation

Visit `http://localhost:3000/api-docs` for interactive Swagger UI.

## Salesforce Agentforce Integration

The API is designed to be imported into Salesforce as an External Service:

1. Export the OpenAPI spec from `/api-docs`
2. In Salesforce Setup → Einstein Agent → External Services
3. Import the OpenAPI specification
4. Configure authentication (OAuth or API Key)
5. Use in Einstein Agent flows: "What changed in Flow X?"

## Project Structure

```
src/
├── types/           # TypeScript type definitions
├── services/        # Core business logic
│   ├── authService.ts
│   ├── aiService.ts
│   ├── salesforceService.ts
│   ├── pollingService.ts
│   └── slackService.ts
├── routes/          # Express routes
│   ├── agentforce.ts
│   └── auth.ts
├── app.ts           # Express app configuration
└── index.ts         # Application entry point
```

## Key Architectural Decisions

1. **No Local Git**: All metadata is fetched fresh from Salesforce APIs
2. **Token Optimization**: Visual noise (`locationX`, `locationY`, `processMetadataValues`) is stripped before AI analysis
3. **Enterprise Billing**: Vertex AI calls include `X-Goog-User-Project` header for customer billing
4. **Redis Caching**: OAuth tokens cached with 7-day TTL, auto-refreshed before API calls

## Development

```bash
# Lint
npm run lint

# Type check
npm run build
```

## License

ISC

