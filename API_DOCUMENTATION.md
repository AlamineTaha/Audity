# AuditDelta API Documentation
## Complete Endpoint Reference & Slack Integration Guide

**Version:** 1.0.0  
**Last Updated:** 2024  
**Purpose:** This document provides comprehensive API documentation for AuditDelta, including request/response examples and detailed Slack integration architecture. Designed for AI review and integration purposes.

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Authentication Endpoints](#authentication-endpoints)
3. [Monitoring Endpoints](#monitoring-endpoints)
4. [Security & Permission Analysis](#security--permission-analysis)
5. [Flow Management Endpoints](#flow-management-endpoints)
6. [Slack Integration Architecture](#slack-integration-architecture)
7. [Slack Message Format Examples](#slack-message-format-examples)
8. [Error Handling](#error-handling)

---

## Architecture Overview

AuditDelta is a Node.js (TypeScript) middleware application that acts as an "Automated Auditor" for Salesforce Orgs. It monitors metadata changes, analyzes them with AI (Google Gemini/Vertex AI), and sends notifications via Salesforce's native Slack integration.

### Key Components

- **Salesforce Integration:** Uses `jsforce` library for Tooling API and Standard API calls
- **AI Analysis:** Google Gemini API (PERSONAL mode) or Vertex AI (ENTERPRISE mode)
- **Notification System:** Salesforce-to-Slack native integration (2026 version)
- **Storage:** Redis for OAuth tokens and org settings
- **Scheduling:** `node-cron` for automated polling every 10 minutes

### Data Flow

```
Salesforce Org → AuditDelta API → AI Analysis (Gemini) → Salesforce Custom Object → Salesforce Flow → Slack
```

---

## Authentication Endpoints

### 1. Initiate OAuth Authorization

**Endpoint:** `GET /auth/authorize`

**Description:** Initiates OAuth 2.0 Web Server Flow (PKCE support) for Salesforce authentication. Redirects user to Salesforce authorization page.

**Query Parameters:**
- `billingMode` (optional): `PERSONAL` or `ENTERPRISE` (default: `PERSONAL`)
- `gcpProjectId` (optional): Required for ENTERPRISE billing mode
- `state` (optional): OAuth state parameter

**Request Example:**
```bash
curl -X GET "http://localhost:3000/auth/authorize?billingMode=PERSONAL"
```

**Response:** HTTP 302 Redirect to Salesforce authorization page

**Success Flow:**
1. User is redirected to Salesforce login page
2. After authorization, Salesforce redirects to `/auth/callback` with authorization code
3. System exchanges code for access/refresh tokens
4. Tokens stored in Redis with org settings

---

### 2. OAuth Callback Handler

**Endpoint:** `GET /auth/callback`

**Description:** Handles OAuth callback from Salesforce. Exchanges authorization code for tokens and stores org settings.

**Query Parameters:**
- `code` (required): Authorization code from Salesforce
- `state` (optional): State parameter (may contain billing mode info)

**Request Example:**
```
GET /auth/callback?code=aPrxrF8KvQ8XgL9jH5mN3pQ6rS7tU8vW9xY0zA1bC2dE3f&state=...
```

**Response Example:**
```json
{
  "success": true,
  "orgId": "00DJ6000001H7etMAC",
  "message": "Organization successfully authenticated"
}
```

**Error Response Example:**
```json
{
  "error": "Invalid authorization code"
}
```

---

## Monitoring Endpoints

### 3. Trigger Manual Change Check

**Endpoint:** `POST /api/v1/trigger-check`

**Description:** Manually triggers the polling engine to check for Salesforce changes immediately. Analyzes changes with AI and sends Slack notifications if issues are found.

**Query Parameters:**
- `hours` (optional): Look back X hours instead of default 10 minutes (e.g., `?hours=24`)

**Request Example:**
```bash
curl -X POST "http://localhost:3000/api/v1/trigger-check?hours=24" \
  -H "accept: application/json"
```

**Response Example (Success):**
```json
{
  "success": true,
  "message": "Manual check completed (24 hour(s)). Found 5 change(s).",
  "changesFound": 5,
  "errors": [],
  "timeWindow": "24 hours"
}
```

**Response Example (No Changes):**
```json
{
  "success": true,
  "message": "Manual check completed (24 hour(s)). Found 0 change(s).",
  "changesFound": 0,
  "errors": [],
  "timeWindow": "24 hours"
}
```

**Response Example (With Errors):**
```json
{
  "success": false,
  "message": "Manual check completed with errors.",
  "changesFound": 2,
  "errors": [
    "Error processing org 00DJ6000001H7etMAC: Connection timeout"
  ],
  "timeWindow": "24 hours"
}
```

**What It Does:**
1. Queries Salesforce SetupAuditTrail for changes in specified time window
2. Detects Flow, Permission, Object, and Validation Rule changes
3. For Flow changes: Fetches versions, generates AI diff analysis
4. Publishes notifications to Salesforce custom object (`AuditDelta_Event__c`)
5. Salesforce Flow triggers and sends formatted message to Slack

---

### 4. Get Recent Changes

**Endpoint:** `GET /api/v1/recent-changes`

**Description:** Retrieves raw Salesforce Audit Trail events. Use this when users ask "What happened recently?" or "Who changed what?"

**Query Parameters:**
- `orgId` (optional): Filter by specific organization ID
- `hours` (optional): Look back window in hours (default: 24)

**Request Example:**
```bash
curl -X GET "http://localhost:3000/api/v1/recent-changes?hours=24&orgId=00DJ6000001H7etMAC" \
  -H "accept: application/json"
```

**Response Example:**
```json
[
  {
    "Id": "0XA000000000001AAA",
    "Action": "createdinteractiondefversion",
    "Display": "Created flow version #7 'Slack Messaging' for flow with Unique Name 'Slack_Messaging'",
    "CreatedBy": {
      "Name": "John Doe",
      "Id": "005J6000002RB2uIAG"
    },
    "CreatedDate": "2024-01-15T10:30:00.000Z",
    "Section": "Flow Management"
  },
  {
    "Id": "0XA000000000002AAA",
    "Action": "PermSetAssign",
    "Display": "Permission set Slack Admin: assigned to user Taha Alamine Boukhalf",
    "CreatedBy": {
      "Name": "Jane Smith",
      "Id": "005J6000003SC3vJBH"
    },
    "CreatedDate": "2024-01-15T09:15:00.000Z",
    "Section": "Security"
  }
]
```

---

## Security & Permission Analysis

### 5. Analyze User Permissions

**Endpoint:** `POST /api/v1/analyze-permission`

**Description:** Traces exactly which Profile or Permission Set grants a specific permission to a user. Supports System Permissions, Object Permissions, and Field Permissions with natural language queries.

**Request Body:**
```json
{
  "userId": "005J6000002RB2uIAG",
  "orgId": "00DJ6000001H7etMAC",
  "permissionName": "Edit Account"
}
```

**Supported Permission Query Formats:**

1. **System Permissions (Natural Language):**
   - `"create report"` → Resolves to `PermissionsCreateReport`
   - `"export reports"` → Resolves to `PermissionsExportReport`
   - `"modify all data"` → Resolves to `PermissionsModifyAllData`
   - `"view setup"` → Resolves to `PermissionsViewSetup`

2. **Object Permissions:**
   - Format: `"Action Object"` (e.g., `"Edit Account"`, `"Delete Lead"`, `"Create Contact"`)
   - Actions: `Read`, `Create`, `Edit`, `Delete`, `ViewAll`, `ModifyAll`

3. **Field Permissions:**
   - Format: `"Action Object Field"` (e.g., `"Edit Account Description"`, `"Read Contact Email"`)

**Request Example (System Permission):**
```bash
curl -X POST "http://localhost:3000/api/v1/analyze-permission" \
  -H "Content-Type: application/json" \
  -d '{
    "userId": "005J6000002RB2uIAG",
    "orgId": "00DJ6000001H7etMAC",
    "permissionName": "export reports"
  }'
```

**Response Example (Has Access):**
```json
{
  "username": "Alice Smith",
  "userId": "005J6000002RB2uIAG",
  "checkingPermission": "PermissionsExportReport",
  "resolvedLabel": "Export Report",
  "hasAccess": true,
  "sources": [
    "Profile: System Administrator",
    "Permission Set: Marketing Manager"
  ],
  "explanation": "User can do this because it is granted by: Profile: System Administrator, Permission Set: Marketing Manager",
  "riskAnalysis": {
    "riskLevel": "LOW",
    "riskReason": "Standard reporting permission with no elevated access risks."
  }
}
```

**Response Example (Object Permission - High Risk):**
```json
{
  "username": "John Doe",
  "userId": "005J6000002RB2uIAG",
  "checkingPermission": "Account",
  "resolvedLabel": "Account",
  "hasAccess": true,
  "sources": [
    "Profile: System Administrator",
    "Permission Set: Sales Manager"
  ],
  "explanation": "User has Edit access to Account object granted by: Profile: System Administrator, Permission Set: Sales Manager",
  "riskAnalysis": {
    "riskLevel": "CRITICAL",
    "riskReason": "User has 'Modify All Records' which allows them to edit every Account record in the org, regardless of sharing rules (God Mode)."
  }
}
```

**Response Example (No Access):**
```json
{
  "username": "Bob Johnson",
  "userId": "005J6000004TD4wKCI",
  "checkingPermission": "PermissionsModifyAllData",
  "resolvedLabel": "Modify All Data",
  "hasAccess": false,
  "sources": [],
  "explanation": "User does not have this permission granted by any Profile or Permission Set.",
  "riskAnalysis": {
    "riskLevel": "LOW",
    "riskReason": "No permissions found."
  }
}
```

**Response Example (Ambiguous Permission):**
```json
{
  "error": "Ambiguous permission query. Found multiple similar permissions:",
  "ambiguousMatches": [
    {
      "apiName": "PermissionsManageUsers",
      "label": "Manage Users"
    },
    {
      "apiName": "PermissionsManageInternalUsers",
      "label": "Manage Internal Users"
    }
  ],
  "message": "Please specify which permission you meant: 'Manage Users' or 'Manage Internal Users'"
}
```

**Error Response (User Not Found):**
```json
{
  "error": "User not found",
  "message": "Could not find user with ID or username: 005J6000002RB2uIAG"
}
```

---

## Flow Management Endpoints

### 6. Analyze Flow Changes

**Endpoint:** `POST /api/v1/analyze-flow`

**Description:** Fetches current and previous Flow versions, uses AI to analyze differences, and returns comprehensive analysis including risk assessment, revert options, and dependency mapping.

**Request Body:**
```json
{
  "flowName": "Slack_Messaging",
  "orgId": "00DJ6000001H7etMAC"
}
```

**Request Example:**
```bash
curl -X POST "http://localhost:3000/api/v1/analyze-flow" \
  -H "Content-Type: application/json" \
  -d '{
    "flowName": "Slack_Messaging",
    "orgId": "00DJ6000001H7etMAC"
  }'
```

**Response Example:**
```json
{
  "success": true,
  "flowName": "Slack_Messaging",
  "summary": "The Flow was updated to include a new decision element that checks if the message contains sensitive data before sending to Slack. Added field validation for PII detection.",
  "changes": [
    "Added new decision element: 'Check for PII'",
    "Modified field update logic: Added validation for SSN and Email fields",
    "Updated error handling: Added try-catch block for API failures"
  ],
  "riskAnalysis": {
    "riskLevel": "HIGH",
    "riskReason": "Flow now accesses PII fields (SSN, Email) which could expose sensitive data if not properly secured."
  },
  "revertOptions": {
    "summary": "5 change(s) detected today.",
    "versionsToday": [7, 6, 5, 4, 3],
    "recommendedStableVersion": 2,
    "revertPrompt": "Would you like to activate Version 2 (Last Stable), a specific version, or keep the current changes?"
  },
  "dependencies": {
    "reportedDependencies": [
      {
        "type": "Apex Class",
        "name": "SlackIntegrationHandler",
        "description": "Calls this flow via Flow.Interview"
      }
    ],
    "uiDependencies": {
      "buttons": [
        {
          "name": "Send_To_Slack_Button",
          "label": "Send to Slack",
          "linkType": "url",
          "objectType": "Account"
        }
      ],
      "quickActions": [
        {
          "actionTarget": "Slack_Messaging",
          "label": "Send Slack Message",
          "targetObject": "Case"
        }
      ]
    },
    "subflowDependencies": [
      {
        "flowApiName": "Validate_Input",
        "elementLabel": "Validate Input Step"
      }
    ],
    "securityNote": "Dependency analysis performed via safe metadata headers only. No proprietary codebase (Apex/LWC) was accessed.",
    "limitations": [
      "Analysis limited to Metadata (Subflows/Buttons). External callers (Apex/LWC) were not scanned."
    ]
  },
  "revertImpact": {
    "warnings": [
      "Warning: Reverting to Version 2 may fail if it references fields that have since been deleted or modified.",
      "Current version uses field 'Account__c.SSN__c' which was added in Version 4."
    ],
    "activeSessions": 3,
    "canRevert": true
  }
}
```

---

### 7. Check Revert Impact

**Endpoint:** `POST /api/v1/flows/check-revert-impact`

**Description:** Checks potential impact before reverting a Flow version. Compares active version with target version and warns about missing fields/objects or active sessions.

**Request Body:**
```json
{
  "flowName": "Slack_Messaging",
  "orgId": "00DJ6000001H7etMAC",
  "targetVersionNumber": 2
}
```

**Response Example:**
```json
{
  "warnings": [
    "Warning: Reverting to Version 2 may fail if it references fields that have since been deleted or modified.",
    "Current version uses field 'Account__c.SSN__c' which was added in Version 4."
  ],
  "activeSessions": 3,
  "canRevert": true,
  "message": "Revert is possible, but 3 active Flow Interviews will continue running on the old version until completed or manually deleted."
}
```

---

### 8. Activate Specific Flow Version

**Endpoint:** `POST /api/v1/flows/activate-version`

**Description:** Activates a specific Flow version by setting it as the active version. This is a "Safe-Revert" operation that only changes status, never deletes anything.

**Request Body:**
```json
{
  "flowName": "Slack_Messaging",
  "orgId": "00DJ6000001H7etMAC",
  "targetVersionNumber": 2
}
```

**Response Example:**
```json
{
  "success": true,
  "message": "Successfully activated Version 2 of Flow 'Slack_Messaging'",
  "previousActiveVersion": 7,
  "newActiveVersion": 2,
  "warnings": [
    "Note: 3 active/paused Flow Interviews will continue to run on Version 7 until they are completed or deleted manually in Salesforce."
  ]
}
```

---

### 9. Batch Revert Today's Changes

**Endpoint:** `POST /api/v1/flows/revert-today`

**Description:** Batch reverts all Flow changes made today by activating the last stable version from before today.

**Request Body:**
```json
{
  "flowName": "Slack_Messaging",
  "orgId": "00DJ6000001H7etMAC",
  "hours": 24
}
```

**Response Example:**
```json
{
  "success": true,
  "message": "Successfully reverted Flow 'Slack_Messaging' to stable Version 2 (last version before today's changes)",
  "stableVersion": 2,
  "previousActiveVersion": 7,
  "warnings": [
    "Note: 3 active/paused Flow Interviews will continue to run on Version 7 until they are completed or deleted manually in Salesforce."
  ]
}
```

---

### 10. Get Flow Version History

**Endpoint:** `GET /api/v1/flows/versions`

**Description:** Returns list of Flow versions modified within a specified time window.

**Query Parameters:**
- `flowName` (required): API name of the Flow
- `orgId` (required): Organization ID
- `hours` (optional): Time window in hours (default: 24)

**Request Example:**
```bash
curl -X GET "http://localhost:3000/api/v1/flows/versions?flowName=Slack_Messaging&orgId=00DJ6000001H7etMAC&hours=24"
```

**Response Example:**
```json
[
  {
    "versionNumber": 7,
    "modifiedBy": "John Doe",
    "timestamp": "2024-01-15T10:30:00.000Z",
    "status": "Active",
    "versionId": "301J6000002RB2uIAG"
  },
  {
    "versionNumber": 6,
    "modifiedBy": "Jane Smith",
    "timestamp": "2024-01-15T09:15:00.000Z",
    "status": "Obsolete",
    "versionId": "301J6000003SC3vJBH"
  }
]
```

---

## Slack Integration Architecture

### Overview

AuditDelta uses **Salesforce's native Slack integration (2026 version)** instead of webhooks. This provides better security, centralized management, and eliminates the need to manage Slack API credentials in the Node.js application.

### Integration Flow

```
┌─────────────────┐
│  AuditDelta     │
│  Node.js App    │
└────────┬────────┘
         │
         │ 1. publishAuditToSalesforce()
         │    Creates record in AuditDelta_Event__c
         ▼
┌─────────────────┐
│  Salesforce     │
│  Custom Object  │
│  AuditDelta_    │
│  Event__c       │
└────────┬────────┘
         │
         │ 2. Record Created Trigger
         │    Activates Salesforce Flow
         ▼
┌─────────────────┐
│  Salesforce     │
│  Flow           │
│  (Slack         │
│  Integration)   │
└────────┬────────┘
         │
         │ 3. Send Message Action
         │    Uses native Slack connector
         ▼
┌─────────────────┐
│  Slack          │
│  Channel        │
└─────────────────┘
```

### Step-by-Step Process

#### Step 1: Change Detection
When `trigger-check` or scheduled polling detects a change:

```typescript
// In monitorService.ts or pollingService.ts
await this.salesforceService.publishAuditToSalesforce(
  orgId,
  summaryText,
  flowName
);
```

#### Step 2: Record Creation
The `publishAuditToSalesforce` method creates a record:

```typescript
// Creates record in AuditDelta_Event__c custom object
{
  Name: `Flow Update: ${flowName}`,
  Message__c: summaryText,  // Formatted message with markdown
  CreatedDate: new Date()
}
```

#### Step 3: Salesforce Flow Trigger
Salesforce Flow is configured with:
- **Trigger:** `AuditDelta_Event__c` record created
- **Action:** Send message to Slack using native Slack connector
- **Channel:** Hardcoded Slack channel ID (configured in Flow)

#### Step 4: Slack Message Delivery
Salesforce handles:
- Authentication with Slack (OAuth managed by Salesforce)
- Message formatting (supports Slack Block Kit)
- Delivery retry logic
- Error handling

### Benefits of Native Integration

1. **Security:** No webhook URLs or API keys to manage in Node.js
2. **Reliability:** Salesforce handles retries and error recovery
3. **Centralized:** All Slack configuration in Salesforce
4. **Scalable:** No rate limiting concerns in Node.js app
5. **Maintainable:** Changes to Slack integration don't require code deployment

---

## Slack Message Format Examples

### Flow Change Notification

**Message Structure:**
```
🚨 Flow Change Detected: [FlowName]

Summary:
[AI-generated summary of changes]

Changes:
• [Change 1]
• [Change 2]
• [Change 3]

Risk Level: 🔴 High
Changed by: [UserName]
Time: [Timestamp]
View in Salesforce: [URL]
```

**Example Slack Message:**
```
🚨 **Flow Change Detected: Slack_Messaging**

**Summary:**
The Flow was updated to include a new decision element that checks if the message contains sensitive data before sending to Slack. Added field validation for PII detection.

**Changes:**
• Added new decision element: 'Check for PII'
• Modified field update logic: Added validation for SSN and Email fields
• Updated error handling: Added try-catch block for API failures

**Risk Level:** 🔴 High
**Changed by:** John Doe
**Time:** 1/15/2024, 10:30:00 AM
**View in Salesforce:** https://yourinstance.salesforce.com/lightning/setup/Flows/home
```

**Slack Block Kit Format (for Salesforce Flow):**
```json
{
  "blocks": [
    {
      "type": "header",
      "text": {
        "type": "plain_text",
        "text": "🚨 Flow Change Detected: Slack_Messaging"
      }
    },
    {
      "type": "section",
      "fields": [
        {
          "type": "mrkdwn",
          "text": "*Changed by:*\nJohn Doe"
        },
        {
          "type": "mrkdwn",
          "text": "*Risk Level:*\n🔴 High"
        },
        {
          "type": "mrkdwn",
          "text": "*Time:*\n1/15/2024, 10:30:00 AM"
        }
      ]
    },
    {
      "type": "section",
      "text": {
        "type": "mrkdwn",
        "text": "*Summary:*\nThe Flow was updated to include a new decision element that checks if the message contains sensitive data before sending to Slack."
      }
    },
    {
      "type": "section",
      "text": {
        "type": "mrkdwn",
        "text": "*Changes:*\n• Added new decision element: 'Check for PII'\n• Modified field update logic: Added validation for SSN and Email fields\n• Updated error handling: Added try-catch block for API failures"
      }
    },
    {
      "type": "actions",
      "elements": [
        {
          "type": "button",
          "text": {
            "type": "plain_text",
            "text": "View in Salesforce"
          },
          "url": "https://yourinstance.salesforce.com/lightning/setup/Flows/home",
          "action_id": "view_salesforce"
        }
      ]
    }
  ]
}
```

---

### Permission Change Notification

**Example Slack Message:**
```
🔐 **Permission Change Detected**

**Change:** Permission set Slack Admin: assigned to user Taha Alamine Boukhalf

**Changed by:** Jane Smith
**Time:** 1/15/2024, 9:15:00 AM
**Risk Level:** 🟡 Medium
**View in Salesforce:** https://yourinstance.salesforce.com/lightning/setup/Security/home
```

---

### Object Change Notification

**Example Slack Message:**
```
📊 **Object Change Detected**

**Change:** Created custom object Custom_Event__c

**Changed by:** Bob Johnson
**Time:** 1/15/2024, 8:00:00 AM
**Risk Level:** 🟡 Medium
**View in Salesforce:** https://yourinstance.salesforce.com/lightning/setup/ObjectManager/home
```

---

### Validation Rule Change Notification

**Example Slack Message:**
```
🔍 **Validation Rule Updated: Prevent_Invalid_Email**

**Formula:**
```
ISBLANK(Email) || NOT(REGEX(Email, "[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}"))
```

**AI Interpretation:**
This validation rule prevents users from saving records with blank or invalid email addresses. It uses a regex pattern to validate email format and blocks records that don't match the standard email format.

**Changed by:** Alice Smith
**Time:** 1/15/2024, 11:00:00 AM
```

---

## Error Handling

### Common Error Responses

#### 400 Bad Request
```json
{
  "error": "Missing required field: orgId"
}
```

#### 401 Unauthorized
```json
{
  "error": "Invalid or expired access token. Please re-authenticate via /auth/authorize"
}
```

#### 404 Not Found
```json
{
  "error": "Flow not found",
  "message": "Could not find Flow with API name: NonExistent_Flow"
}
```

#### 500 Internal Server Error
```json
{
  "error": "Internal server error",
  "message": "Failed to connect to Salesforce: Connection timeout"
}
```

### Token Refresh Logic

The system automatically handles token refresh:

1. **Detection:** When a Salesforce API call returns `INVALID_SESSION_ID`
2. **Refresh:** Calls `authService.refreshToken(orgId)` to get new access token
3. **Retry:** Retries the original query once
4. **Failure:** If refresh fails, returns 401 error requesting re-authentication

---

## Configuration Requirements

### Environment Variables

```bash
# Salesforce OAuth
SALESFORCE_CLIENT_ID=your_client_id
SALESFORCE_CLIENT_SECRET=your_client_secret
SALESFORCE_REDIRECT_URI=http://localhost:3000/auth/callback

# Redis (for token storage)
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=your_redis_password  # Optional

# AI Service (Gemini)
GEMINI_API_KEY=your_gemini_api_key  # For PERSONAL billing mode
GCP_PROJECT_ID=your_gcp_project_id  # For ENTERPRISE billing mode

# Server
PORT=3000
NODE_ENV=development
```

### Salesforce Setup

1. **Custom Object:** Create `AuditDelta_Event__c` with fields:
   - `Name` (Text, 255)
   - `Message__c` (Long Text Area, 32768)

2. **Flow Configuration:**
   - Trigger: Record Created on `AuditDelta_Event__c`
   - Action: Send Message to Slack
   - Channel: Configure your Slack channel ID
   - Message: Use `{!AuditDelta_Event__c.Message__c}`

3. **Slack App Setup:**
   - Install Slack app in Salesforce
   - Authorize Salesforce to access Slack workspace
   - Configure channel permissions

---

## Testing Guide

### Test Flow Change Detection

```bash
# 1. Trigger manual check
curl -X POST "http://localhost:3000/api/v1/trigger-check?hours=24"

# 2. Make a change in Salesforce (e.g., edit a Flow)

# 3. Check recent changes
curl -X GET "http://localhost:3000/api/v1/recent-changes?hours=1"

# 4. Verify Slack notification was received
```

### Test Permission Analysis

```bash
# System Permission
curl -X POST "http://localhost:3000/api/v1/analyze-permission" \
  -H "Content-Type: application/json" \
  -d '{
    "userId": "005J6000002RB2uIAG",
    "orgId": "00DJ6000001H7etMAC",
    "permissionName": "export reports"
  }'

# Object Permission
curl -X POST "http://localhost:3000/api/v1/analyze-permission" \
  -H "Content-Type: application/json" \
  -d '{
    "userId": "005J6000002RB2uIAG",
    "orgId": "00DJ6000001H7etMAC",
    "permissionName": "Edit Account"
  }'
```

### Test Flow Analysis

```bash
curl -X POST "http://localhost:3000/api/v1/analyze-flow" \
  -H "Content-Type: application/json" \
  -d '{
    "flowName": "Slack_Messaging",
    "orgId": "00DJ6000001H7etMAC"
  }'
```

---

## API Rate Limits & Best Practices

### Rate Limits
- **Salesforce API:** 10,000 API calls per 24 hours (default org limit)
- **Gemini API:** Varies by billing plan
- **Redis:** No practical limits for this use case

### Best Practices

1. **Use `hours` parameter wisely:** Don't query 24 hours of data if you only need recent changes
2. **Cache permission lookups:** Permission Set metadata doesn't change frequently
3. **Batch operations:** Use batch revert endpoints instead of individual version activations
4. **Error handling:** Always check `success` field and handle `errors` array
5. **Token management:** System handles refresh automatically, but monitor for 401 errors

---

## Support & Troubleshooting

### Common Issues

**Issue:** `trigger-check` returns 0 changes but changes exist
- **Solution:** Check that action types match detection logic (e.g., `createdinteractiondefversion` for Flows)

**Issue:** Slack notifications not received
- **Solution:** Verify Salesforce Flow is configured correctly and Slack app is authorized

**Issue:** Permission analysis returns ambiguous matches
- **Solution:** Use more specific permission name or exact API name

**Issue:** Token refresh fails
- **Solution:** Re-authenticate via `/auth/authorize` endpoint

---

## Version History

- **v1.0.0** (2024): Initial release with native Slack integration
  - Flow change detection and analysis
  - Permission tracing (System, Object, Field)
  - Safe Flow revert functionality
  - Salesforce-to-Slack native integration

---

**End of Documentation**
