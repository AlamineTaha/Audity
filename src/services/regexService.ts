/**
 * @fileoverview Provides a service for parsing Salesforce Setup Audit Trail strings.
 * This helper is crucial for extracting the necessary metadata components from the
 * often inconsistent 'Display' field of SetupAuditTrail records. The extracted
 * identifiers are used to query the Tooling API for the full metadata definition.
 */

/**
 * A structured representation of the identifiers needed to query the Tooling API.
 */
export interface ToolingApiFilter {
    /** The API name of the metadata component (e.g., MyCustomField, MyValidationRule). */
    DeveloperName: string | null;
    /** The object the component belongs to (e.g., Account, Case). Null if not applicable. */
    TableEnumOrId: string | null;
    /** The name of the Tooling API SObject to query (e.g., CustomField, ValidationRule). */
    ToolingApiObject: string;
}

/**
 * Parses the Setup Audit Trail 'Display' string to extract identifiers
 * needed for a follow-up query to the Tooling API.
 * 
 * The function cycles through known patterns for different metadata types.
 *
 * @param displayString The 'Display' field from a SetupAuditTrail record.
 * @returns A ToolingApiFilter object with the extracted identifiers, or null if no pattern matches.
 */
export function parseDisplayString(displayString: string): ToolingApiFilter | null {
    /**
     * An ordered list of RegEx patterns to match against the display string.
     * Each pattern is designed to capture specific metadata types.
     * The key is the Tooling API Object name, and the value is the regex.
     */
    const patterns: { [key: string]: RegExp } = {
        // Pattern for Custom Fields.
        // e.g., "Changed custom field My_Custom_Field__c on object Lead from..."
        CustomField: /custom field\s+([\w.-]+__c)\s+on object\s+([\w.-]+)/i,

        // Pattern for Validation Rules.
        // e.g., "Changed validation rule My_Rule on object Case."
        ValidationRule: /validation rule\s+([\w.-]+)\s+on object\s+([\w.-]+)/i,

        // Pattern for Flows. They have various display string formats.
        // e.g., "Created version 12 of flow My_Flow" or "Activated flow My_Other_Flow"
        FlowDefinition: /(?:version of flow|flow|interview)\s+([\w.-]+)/i
    };

    for (const toolingApiObject in patterns) {
        const regex = patterns[toolingApiObject];
        const match = displayString.match(regex);

        if (match) {
            switch (toolingApiObject) {
                case 'CustomField':
                    if (match[1] && match[2]) {
                        return {
                            // Strip the __c suffix to get the DeveloperName
                            DeveloperName: match[1].replace(/__c$/, ''),
                            TableEnumOrId: match[2],
                            ToolingApiObject: 'CustomField'
                        };
                    }
                    break;
                
                case 'ValidationRule':
                    if (match[1] && match[2]) {
                        return {
                            // For ValidationRule, the captured name is the DeveloperName (ValidationName)
                            DeveloperName: match[1],
                            TableEnumOrId: match[2],
                            ToolingApiObject: 'ValidationRule'
                        };
                    }
                    break;
                
                case 'FlowDefinition':
                    if (match[1]) {
                        return {
                            DeveloperName: match[1],
                            TableEnumOrId: null, // Not applicable for FlowDefinition
                            ToolingApiObject: 'FlowDefinition'
                        };
                    }
                    break;
            }
        }
    }

    // Return null if no patterns matched the display string.
    return null;
}
