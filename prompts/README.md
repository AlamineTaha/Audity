# LLM Prompts

This directory contains the prompts sent to the LLM (Gemini/Vertex AI), organized by category.

## Structure

| Folder | Description |
|--------|-------------|
| **Flows** | Flow diff analysis, development session aggregation |
| **schema** | Validation rules, formula fields, custom fields, metadata interpretation |
| **security** | Audit trail action interpretation (currently disabled) |

## Files

### Flows
- `generate-summary.md` – Compare two Flow versions, produce Slack-ready summary with security findings
- `analyze-development-session.md` – Aggregate multiple changes in a development session

### schema
- `interpret-validation-formula.md` – Explain a single Validation Rule formula
- `compare-validation-rule-formulas.md` – Explain differences between two Validation Rule formulas
- `interpret-metadata-flow.md` – Explain Flow metadata to business users
- `interpret-metadata-validation-rule.md` – Explain Validation Rule metadata
- `interpret-metadata-formula-field.md` – Explain Formula Field metadata
- `interpret-metadata-custom-field.md` – Explain Custom Field metadata
- `interpret-metadata-generic.md` – Generic metadata explanation (fallback)

### security
- `interpret-unmapped-action.md` – Explain unmapped audit trail actions (disabled in code)

## Logging

All prompts and responses are logged to `llm_prompts_log.jsonl` in the project root. See [LLM_PROMPTS_LOG_README.md](../LLM_PROMPTS_LOG_README.md) for details.
