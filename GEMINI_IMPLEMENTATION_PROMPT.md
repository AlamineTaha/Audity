# AuditDelta: Flow Monitoring Refactor – Implementation Summary for Gemini LLM

## Context

This document describes changes made to the AuditDelta application to move from a "Waiting Room" delay model for Flow changes to immediate reaction with Slack thread aggregation. It is intended to be read by a Gemini LLM for context or continuation of the implementation.

---

## 1. Flow Trigger Refinement (Tooling API Only)

**Before:** Flow changes were detected for any action containing "flow" (e.g., `createdinteractiondefversion`, `activatedinteractiondefversion`, `deactivatedinteractiondefversion`, `createdinteractiondefinition`, `changedflow`, etc.).

**After:** Flow detection is limited to **activation only**:
- `isFlowChange()` now matches only `activatedinteractiondefversion`
- No other flow-related actions (create, deactivate, etc.) trigger processing

**Version check:** Before processing, the system:
1. Extracts the activated version from the SetupAuditTrail `Display` field (e.g., "Activated flow version #7")
2. Calls `getFlowMaxVersion(orgId, flowName)` via Tooling API to get the latest `VersionNumber`
3. Skips the notification if the activated version is **not** the latest
4. Exception: rollback cases (activating an older version) are still processed when the version matches the activated version

---

## 2. Flow Delta (N vs N-1)

**New method:** `getFlowDelta(orgId, flowName)` in `SalesforceService.ts`

**Implementation:**
- Uses Tooling API to query: `SELECT Id, VersionNumber, Metadata, Status FROM Flow WHERE DefinitionId = '...' ORDER BY VersionNumber DESC LIMIT 2`
- Returns `{ current, previous, currentVersion, previousVersion }` with the Metadata JSON blobs
- The current version (V-n) and previous version (V-n-1) Metadata are passed to the AI Service for comparison
- Replaces the previous `getFlowVersions`-based approach for Flow processing

**Helper:** `getFlowMaxVersion(orgId, flowName)` returns the highest `VersionNumber` for a Flow to validate that the activated version is the latest.

---

## 3. Threaded Ledger (Redis) Replaces Waiting Room

**Removed:**
- 5-minute buffering logic for Flow changes
- `WaitingRoomService` integration with `MonitorService`
- `processWaitingRoomSession` and related flow aggregation
- `ensureWaitingRoomStarted` now only initializes the monitor service

**Added:**
- Redis keys: `flow_thread:[OrgId]:[FlowDeveloperName]` with a 36-hour TTL (129,600 seconds)
- `getFlowThreadTs(orgId, flowDeveloperName)` and `setFlowThreadTs(orgId, flowDeveloperName, threadTs)` in `SalesforceAuthService`
- When posting a Flow change:
  - If `flow_thread` key exists: pass `threadTs` to `publishAuditToSalesforce` (sets `Thread_Timestamp__c` on the record)
  - If key does not exist: post as a new message; the Salesforce Flow must call `POST /api/v1/slack-thread-callback` with `{ orgId, flowDeveloperName, threadTs }` after posting to Slack so the app can store the thread ts for future replies

**`publishAuditToSalesforce`:** When `threadTs` is provided, it sets `record.Thread_Timestamp__c = threadTs` so the Flow can use it for threading.

---

## 4. Deduplication & Self-Healing Loop Fix

**Kept:**
- `audit_processed:[OrgId]:[SetupAuditTrail.Id]` Redis keys for deduplication
- `isAuditRecordProcessed` and `markAuditRecordProcessed` behavior unchanged

**Added:**
- `setupEntityObjectFieldUpdated` action is explicitly ignored to break the self-healing loop
- Combined with existing filters for `auditdelta_event__c` and `slack_channel_mapping`

---

## 5. New Endpoint

**`POST /api/v1/slack-thread-callback`**
- Body: `{ orgId, flowDeveloperName, threadTs }`
- Purpose: Called by the Salesforce Flow after posting to Slack to store the returned `ts` in Redis
- Stores `flow_thread:[orgId]:[flowDeveloperName]` with a 36-hour TTL (129,600 seconds)

---

## 6. Files Modified

| File | Changes |
|------|---------|
| `src/services/salesforceService.ts` | Added `getFlowDelta`, `getFlowMaxVersion`; set `Thread_Timestamp__c` when `threadTs` is provided |
| `src/services/authService.ts` | Added `getFlowThreadTs`, `setFlowThreadTs` with 36h TTL |
| `src/services/monitorService.ts` | Activation-only flow detection; version check; removed Waiting Room; use `getFlowDelta`; flow thread logic |
| `src/routes/monitoring.ts` | Removed `WaitingRoomService`; added `slack-thread-callback` endpoint |
| `src/index.ts` | No changes; `ensureWaitingRoomStarted` still called but no longer starts the waiting room |

---

## 7. Salesforce Flow Required Changes

For the threaded ledger to work:

1. **On `AuditDelta_Event__c` record create:** Flow must read `Thread_Timestamp__c` from the record.
2. **If `Thread_Timestamp__c` is set:** Post the message as a reply to that thread using Slack’s `thread_ts`.
3. **If `Thread_Timestamp__c` is null:** Post a new message to the channel.
4. **After posting:** Call `POST {AUDITDELTA_BASE_URL}/api/v1/slack-thread-callback` with:
   ```json
   { "orgId": "...", "flowDeveloperName": "Flow_API_Name", "threadTs": "1234567890.123456" }
   ```
   This stores the thread ts for the next 36 hours so future Flow activations for the same Flow are posted in the same thread.

---

## 8. Summary

- Flow changes are limited to activations and only when the activated version is the latest.
- Flow diff uses `getFlowDelta` (N vs N-1 Metadata) instead of the old version logic.
- Flow notifications are sent immediately; no Waiting Room buffering.
- Flow notifications are grouped in Slack threads using Redis (`flow_thread` keys with 36h TTL).
- `setupEntityObjectFieldUpdated` is ignored to avoid self-healing loops.
- Existing `audit_processed` deduplication remains in place.
