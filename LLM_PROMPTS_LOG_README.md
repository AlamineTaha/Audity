# LLM Prompts Log

Prompt templates are stored in **`prompts/`** grouped by folder:
- **Flows/** – Flow diff summary, development session analysis
- **schema/** – Validation rules, formula fields, metadata interpretation
- **security/** – Audit trail action interpretation (disabled)

Every prompt sent to the LLM (Gemini/Vertex AI) and its response is logged to:

1. **`llm_prompts_log.jsonl`** (project root) – append-only JSONL
2. **`llm_prompts_log/{Flows|schema|security}/`** – one JSON file per prompt

Each individual file is named `{timestamp}_{method}.json` (e.g. `2026-02-12T10-44-38.123Z_generateSummary.json`) and contains the full log entry.

## Format

Each line is a JSON object with:

| Field | Description |
|-------|--------------|
| `timestamp` | ISO timestamp when the call was made |
| `method` | Which AI method made the call: `generateSummary`, `analyzeDevelopmentSession`, `interpretMetadataChange`, `compareValidationRuleFormulas`, `interpretValidationFormula` |
| `context` | Method + orgId for tracing |
| `prompt` | Full prompt sent to the LLM |
| `response` | Full response from the LLM |
| `promptLength` | Character count of prompt |
| `responseLength` | Character count of response |

## Debugging Duplicate Slack Messages

If you're seeing duplicate `AuditDelta_Event__c` records with different `Message__c` but identical context:

1. **Find the matching entries** – Search the log for the same `method` and similar `timestamp` (within seconds).
2. **Compare prompts** – If two entries have identical or nearly identical `prompt` but different `response`, the LLM is producing varied output for the same input.
3. **Trace the flow**:
   - `generateSummary` → Individual Flow change (immediate publish when `forceImmediate`)
   - `analyzeDevelopmentSession` → Aggregated session (after 5-min waiting room expires)
   - If both run for the same Flow/context, you may get two Slack messages.

## Per-Prompt File Structure

| Folder | Methods |
|--------|---------|
| `llm_prompts_log/Flows/` | `generateSummary`, `analyzeDevelopmentSession` |
| `llm_prompts_log/schema/` | `interpretValidationFormula`, `compareValidationRuleFormulas`, `interpretMetadataChange:*` |
| `llm_prompts_log/security/` | `interpretUnmappedAction` (when enabled) |

## Viewing the Log

```bash
# Last 5 entries (pretty-printed)
tail -5 llm_prompts_log.jsonl | jq .

# Search for a specific method
grep '"method":"generateSummary"' llm_prompts_log.jsonl | jq .

# Extract just prompts and responses
jq -r '"\(.timestamp) \(.method): \(.response[:80])..."' llm_prompts_log.jsonl
```

## Log Rotation

When the file exceeds 10 MB, it is rotated to `llm_prompts_log.{timestamp}.jsonl.bak`.
