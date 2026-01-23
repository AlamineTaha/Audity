import { SalesforceAuthService } from './authService';
import { FlowMetadata, SetupAuditTrail } from '../types';

export class SalesforceService {
  private authService: SalesforceAuthService;

  constructor(authService: SalesforceAuthService) {
    this.authService = authService;
  }

  /**
   * Resolve System Permission field name dynamically using describe method
   * Converts natural language queries (e.g., "export reports", "create report", "modify all data") 
   * into Salesforce API Names (e.g., PermissionsExportReport, PermissionsCreateReport, PermissionsModifyAllData)
   * 
   * Supports both natural language queries and exact API names:
   * - Natural language: "export reports" → "PermissionsExportReport"
   * - Natural language: "create report" → "PermissionsCreateReport"
   * - Exact API name: "PermissionsExportReport" → "PermissionsExportReport"
   * 
   * @param conn jsforce Connection instance
   * @param userQuery Natural language permission query (e.g., "create report", "export reports") or exact API name (e.g., "PermissionsCreateReport")
   * @returns Object with apiName and label, or null if not found
   */
  private async resolveSystemPermissionField(conn: any, userQuery: string): Promise<{ apiName: string; label: string } | null> {
    try {
      // Describe returns ALL fields, including 'PermissionsExportReport', etc.
      const description = await conn.describe('PermissionSet');
      
      const normalizedQuery = userQuery.toLowerCase().trim();

      if (!normalizedQuery) {
        return null;
      }

      const match = description.fields.find((field: any) => {
        // We only care about fields that start with "Permissions" (System Permissions)
        if (!field.name.startsWith('Permissions')) {
          return false;
        }

        const label = (field.label || '').toLowerCase();
        const name = field.name.toLowerCase();

        // Check for fuzzy match on Label or exact match on API Name
        return label.includes(normalizedQuery) || name === normalizedQuery || name.includes(normalizedQuery);
      });

      return match ? { apiName: match.name, label: match.label || match.name } : null;

    } catch (error) {
      console.error('Error describing PermissionSet:', error);
      return null;
    }
  }

  /**
   * Find closest matching field name using Levenshtein distance (fuzzy matching)
   * Used to handle typos in field names
   */
  private findClosestFieldName(fields: any[], userInput: string): { apiName: string; label: string } | null {
    if (!fields || fields.length === 0) {
      return null;
    }

    const normalizedInput = userInput.toLowerCase().trim();
    
    // First try exact match (case-insensitive)
    const exactMatch = fields.find(f => 
      f.name.toLowerCase() === normalizedInput || 
      (f.label && f.label.toLowerCase() === normalizedInput)
    );
    if (exactMatch) {
      return { apiName: exactMatch.name, label: exactMatch.label || exactMatch.name };
    }

    // Then try contains match
    const containsMatch = fields.find(f => 
      f.name.toLowerCase().includes(normalizedInput) ||
      (f.label && f.label.toLowerCase().includes(normalizedInput))
    );
    if (containsMatch) {
      return { apiName: containsMatch.name, label: containsMatch.label || containsMatch.name };
    }

    // Finally, use simple Levenshtein-like distance (find field with most common characters)
    let bestMatch: any = null;
    let bestScore = 0;

    for (const field of fields) {
      const fieldName = field.name.toLowerCase();
      const fieldLabel = (field.label || '').toLowerCase();
      
      // Calculate similarity score (simple character overlap)
      let score = 0;
      for (let i = 0; i < normalizedInput.length; i++) {
        if (fieldName.includes(normalizedInput[i]) || fieldLabel.includes(normalizedInput[i])) {
          score++;
        }
      }
      
      // Bonus for starting with same characters
      if (fieldName.startsWith(normalizedInput.substring(0, Math.min(3, normalizedInput.length)))) {
        score += 5;
      }
      
      if (score > bestScore) {
        bestScore = score;
        bestMatch = field;
      }
    }

    return bestMatch ? { apiName: bestMatch.name, label: bestMatch.label || bestMatch.name } : null;
  }

  /**
   * Resolve object name with fuzzy matching to handle typos
   */
  private async resolveObjectName(conn: any, userInput: string): Promise<{ apiName: string; label: string } | null> {
    try {
      const globalDescribe = await conn.describeGlobal();
      const objects = globalDescribe.sobjects || [];
      
      const normalizedInput = userInput.toLowerCase().trim();
      
      // Try exact match first
      const exactMatch = objects.find((obj: any) => 
        obj.name.toLowerCase() === normalizedInput || 
        (obj.label && obj.label.toLowerCase() === normalizedInput)
      );
      if (exactMatch) {
        return { apiName: exactMatch.name, label: exactMatch.label || exactMatch.name };
      }

      // Try contains match
      const containsMatch = objects.find((obj: any) => 
        obj.name.toLowerCase().includes(normalizedInput) ||
        (obj.label && obj.label.toLowerCase().includes(normalizedInput))
      );
      if (containsMatch) {
        return { apiName: containsMatch.name, label: containsMatch.label || containsMatch.name };
      }

      return null;
    } catch (error) {
      console.error('Error resolving object name:', error);
      return null;
    }
  }

  /**
   * Resolve field name with fuzzy matching to handle typos
   */
  private async resolveFieldName(conn: any, objectApiName: string, userInput: string): Promise<{ apiName: string; label: string } | null> {
    try {
      const objectDescribe = await conn.describe(objectApiName);
      const fields = objectDescribe.fields || [];
      
      return this.findClosestFieldName(fields, userInput);
    } catch (error) {
      console.error('Error resolving field name:', error);
      return null;
    }
  }

  /**
   * Map human-readable action names to Salesforce ObjectPermission field names
   */
  private mapActionToFieldName(action: string): string {
    const actionMap: Record<string, string> = {
      'read': 'Read',
      'create': 'Create',
      'edit': 'Edit',
      'delete': 'Delete',
      'viewall': 'ViewAll',
      'modifyall': 'ModifyAll',
      'view all': 'ViewAll',
      'modify all': 'ModifyAll',
    };

    const normalizedAction = action.toLowerCase().trim();
    return actionMap[normalizedAction] || action.charAt(0).toUpperCase() + action.slice(1).toLowerCase();
  }

  /**
   * Check Object-level permissions for a user
   * Returns ALL CRUD rights summary for the object
   * 
   * @param conn jsforce Connection instance
   * @param objectApiName Salesforce object API name (e.g., "Account", "Contact")
   * @param allPermissionSetIds Array of Permission Set IDs (including Profile-owned)
   * @returns Object with CRUD rights summary and sources
   */
  private async checkObjectPermission(
    conn: any,
    objectApiName: string,
    allPermissionSetIds: string[]
  ): Promise<{
    crudRights: string[];
    sources: Record<string, string[]>; // Map of action -> sources
    allSources: string[]; // All unique sources
  }> {
    // Resolve object name with fuzzy matching
    const resolvedObject = await this.resolveObjectName(conn, objectApiName);
    if (!resolvedObject) {
      throw new Error(`Object '${objectApiName}' not found. Please check the object name.`);
    }

    const sanitizedObjectName = resolvedObject.apiName.replace(/'/g, "''");

    if (allPermissionSetIds.length === 0) {
      return {
        crudRights: [],
        sources: {},
        allSources: [],
      };
    }

    const permissionSetIdsStr = allPermissionSetIds.map(id => `'${id.replace(/'/g, "''")}'`).join(', ');

    // Query ObjectPermissions table for ALL CRUD permissions
    const objectPermissionQuery = `
      SELECT Parent.Id, Parent.Label, Parent.IsOwnedByProfile, Parent.Profile.Name,
             PermissionsRead, PermissionsCreate, PermissionsEdit, PermissionsDelete,
             PermissionsViewAll, PermissionsModifyAll
      FROM ObjectPermissions
      WHERE ParentId IN (${permissionSetIdsStr})
        AND SobjectType = '${sanitizedObjectName}'
    `;

    try {
      const result = await conn.query(objectPermissionQuery);
      const crudRights: string[] = [];
      const sources: Record<string, string[]> = {
        Read: [],
        Create: [],
        Edit: [],
        Delete: [],
        ViewAll: [],
        ModifyAll: [],
      };
      const allSourcesSet = new Set<string>();

      if (result.records && result.records.length > 0) {
        for (const record of result.records) {
          const isOwnedByProfile = record.Parent?.IsOwnedByProfile === true;
          const profileName = record.Parent?.Profile?.Name;
          let sourceLabel: string;

          if (isOwnedByProfile && profileName) {
            sourceLabel = `Profile: ${profileName}`;
          } else {
            sourceLabel = `Permission Set: ${record.Parent?.Label || 'Unknown'}`;
          }

          allSourcesSet.add(sourceLabel);

          // Check each CRUD permission
          const actions = [
            { field: 'PermissionsRead', name: 'Read' },
            { field: 'PermissionsCreate', name: 'Create' },
            { field: 'PermissionsEdit', name: 'Edit' },
            { field: 'PermissionsDelete', name: 'Delete' },
            { field: 'PermissionsViewAll', name: 'ViewAll' },
            { field: 'PermissionsModifyAll', name: 'ModifyAll' },
          ];

          for (const action of actions) {
            if (record[action.field] === true) {
              if (!crudRights.includes(action.name)) {
                crudRights.push(action.name);
              }
              if (!sources[action.name].includes(sourceLabel)) {
                sources[action.name].push(sourceLabel);
              }
            }
          }
        }
      }

      return {
        crudRights: crudRights.sort(),
        sources,
        allSources: Array.from(allSourcesSet),
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      
      // Check if object doesn't exist
      if (errorMessage.includes('INVALID_TYPE') || errorMessage.includes('sObject type')) {
        throw new Error(`Object '${objectApiName}' not found. Please check the object name.`);
      }
      
      throw error;
    }
  }

  /**
   * Check Field-level permissions for a user
   * Determines which Permission Sets/Profiles grant field access
   * 
   * @param conn jsforce Connection instance
   * @param objectApiName Salesforce object API name (e.g., "Account")
   * @param fieldApiName Field API name (e.g., "Description")
   * @param allPermissionSetIds Array of Permission Set IDs (including Profile-owned)
   * @returns Object with field permissions and sources
   */
  private async checkFieldPermission(
    conn: any,
    objectApiName: string,
    fieldApiName: string,
    allPermissionSetIds: string[]
  ): Promise<{
    canRead: boolean;
    canEdit: boolean;
    sources: {
      read: string[];
      edit: string[];
    };
    resolvedField: { apiName: string; label: string };
  }> {
    // Resolve object name with fuzzy matching
    const resolvedObject = await this.resolveObjectName(conn, objectApiName);
    if (!resolvedObject) {
      throw new Error(`Object '${objectApiName}' not found. Please check the object name.`);
    }

    // Resolve field name with fuzzy matching
    const resolvedField = await this.resolveFieldName(conn, resolvedObject.apiName, fieldApiName);
    if (!resolvedField) {
      // Get available fields for better error message
      try {
        const objectDescribe = await conn.describe(resolvedObject.apiName);
        const fields = objectDescribe.fields || [];
        const fieldNames = fields.slice(0, 10).map((f: any) => f.name).join(', ');
        throw new Error(
          `I found the ${resolvedObject.label} object, but I couldn't find a field called '${fieldApiName}'. ` +
          `Did you mean one of: ${fieldNames}${fields.length > 10 ? '...' : ''}?`
        );
      } catch (error) {
        throw new Error(`Field '${fieldApiName}' not found on object '${resolvedObject.label}'. Please check the field name.`);
      }
    }

    if (allPermissionSetIds.length === 0) {
      return {
        canRead: false,
        canEdit: false,
        sources: { read: [], edit: [] },
        resolvedField,
      };
    }

    const permissionSetIdsStr = allPermissionSetIds.map(id => `'${id.replace(/'/g, "''")}'`).join(', ');
    
    // Format field as ObjectName.FieldName (Salesforce requirement)
    const fieldFullName = `${resolvedObject.apiName}.${resolvedField.apiName}`;
    const sanitizedFieldName = fieldFullName.replace(/'/g, "''");

    // Query FieldPermissions table
    const fieldPermissionQuery = `
      SELECT Parent.Id, Parent.Label, Parent.IsOwnedByProfile, Parent.Profile.Name,
             PermissionsRead, PermissionsEdit
      FROM FieldPermissions
      WHERE ParentId IN (${permissionSetIdsStr})
        AND SObjectType = '${resolvedObject.apiName.replace(/'/g, "''")}'
        AND Field = '${sanitizedFieldName}'
    `;

    try {
      const result = await conn.query(fieldPermissionQuery);
      const readSources: string[] = [];
      const editSources: string[] = [];
      let canRead = false;
      let canEdit = false;

      if (result.records && result.records.length > 0) {
        for (const record of result.records) {
          const isOwnedByProfile = record.Parent?.IsOwnedByProfile === true;
          const profileName = record.Parent?.Profile?.Name;
          let sourceLabel: string;

          if (isOwnedByProfile && profileName) {
            sourceLabel = `Profile: ${profileName}`;
          } else {
            sourceLabel = `Permission Set: ${record.Parent?.Label || 'Unknown'}`;
          }

          if (record.PermissionsRead === true) {
            canRead = true;
            if (!readSources.includes(sourceLabel)) {
              readSources.push(sourceLabel);
            }
          }

          if (record.PermissionsEdit === true) {
            canEdit = true;
            if (!editSources.includes(sourceLabel)) {
              editSources.push(sourceLabel);
            }
          }
        }
      }

      return {
        canRead,
        canEdit,
        sources: {
          read: readSources,
          edit: editSources,
        },
        resolvedField,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      
      if (errorMessage.includes('INVALID_TYPE') || errorMessage.includes('sObject type')) {
        throw new Error(`Object '${objectApiName}' not found. Please check the object name.`);
      }
      
      throw error;
    }
  }

  /**
   * Query Setup Audit Trail for recent changes
   * @param orgId Salesforce Organization ID
   * @param minutes Number of minutes to look back (default: 10)
   * @returns Array of SetupAuditTrail records
   */
  async queryAuditTrail(orgId: string, minutes: number = 10): Promise<SetupAuditTrail[]> {
    const conn = await this.authService.getConnection(orgId);
    
    // Calculate the timestamp for X minutes ago
    const cutoffTime = new Date();
    cutoffTime.setMinutes(cutoffTime.getMinutes() - minutes);
    const cutoffTimeStr = cutoffTime.toISOString();

    // Query SetupAuditTrail for changes in the specified time window
    // Filter for relevant actions: ChangedFlow, flowChanged, ManagedContent, PublishKnowledge, etc.
    const soql = `
      SELECT Id, Action, Display, CreatedDate, CreatedBy.Id, CreatedBy.Name, Section
      FROM SetupAuditTrail
      WHERE CreatedDate >= ${cutoffTimeStr}
        AND (
          Action LIKE '%Flow%' 
          OR Action LIKE '%Permission%'
          OR Action LIKE '%Object%'
          OR Action = 'ManagedContent'
          OR Action = 'PublishKnowledge'
          OR Action = '%layout%'
          OR Action = '%Formula%'

        )
      ORDER BY CreatedDate DESC
      LIMIT 100
    `;

    try {
      const result = await conn.query<any>(soql);
      
      return result.records.map((record: any) => ({
        Id: record.Id,
        Action: record.Action,
        Display: record.Display,
        CreatedDate: record.CreatedDate,
        CreatedBy: {
          Id: record.CreatedBy?.Id || '',
          Name: record.CreatedBy?.Name || 'Unknown',
        },
        Section: record.Section || '',
        DelegateUser: record.DelegateUser ? {
          Id: record.DelegateUser.Id,
          Name: record.DelegateUser.Name,
        } : undefined,
      })) as SetupAuditTrail[];
    } catch (error) {
      console.error('Error querying audit trail:', error);
      throw error;
    }
  }

  /**
   * Query Setup Audit Trail for a specific time window (in hours)
   * @param orgId Salesforce Organization ID
   * @param hours Number of hours to look back (default: 24)
   * @returns Array of SetupAuditTrail records
   */
  async queryAuditTrailByHours(orgId: string, hours: number = 24): Promise<SetupAuditTrail[]> {
    const conn = await this.authService.getConnection(orgId);
    
    // Calculate the timestamp for X hours ago
    const cutoffTime = new Date();
    cutoffTime.setHours(cutoffTime.getHours() - hours);
    const cutoffTimeStr = cutoffTime.toISOString();

    const soql = `
      SELECT Id, Action, Display, CreatedDate, CreatedBy.Id, CreatedBy.Name, Section
      FROM SetupAuditTrail
      WHERE CreatedDate >= ${cutoffTimeStr}
      ORDER BY CreatedDate DESC
      LIMIT 500
    `;

    try {
      const result = await conn.query<any>(soql);
      
      return result.records.map((record: any) => ({
        Id: record.Id,
        Action: record.Action,
        Display: record.Display,
        CreatedDate: record.CreatedDate,
        CreatedBy: {
          Id: record.CreatedBy?.Id || '',
          Name: record.CreatedBy?.Name || 'Unknown',
        },
        Section: record.Section || '',
        DelegateUser: record.DelegateUser ? {
          Id: record.DelegateUser.Id,
          Name: record.DelegateUser.Name,
        } : undefined,
      })) as SetupAuditTrail[];
    } catch (error) {
      console.error('Error querying audit trail:', error);
      throw error;
    }
  }

  /**
   * Corrected getFlowMetadata
   * 1. Gets the Container ID (FlowDefinition)
   * 2. Gets the Version list (Flow)
   */
  async getFlowMetadata(orgId: string, flowApiName: string): Promise<FlowMetadata | null> {
    const conn = await this.authService.getConnection(orgId);
    const tooling = conn.tooling;
  
    // Step 1: Find the Container ID using the API Name
    const defQuery = `SELECT Id, DeveloperName FROM FlowDefinition WHERE DeveloperName = '${flowApiName}'`;
    const defResult = await tooling.query<any>(defQuery);
    
    if (!defResult.records || defResult.records.length === 0) {
      return null;
    }
    const definitionId = defResult.records[0].Id;

    // Step 2: Get the latest versions belonging to this container
    // We query the 'Flow' table, which represents specific versions
    const flowQuery = `
      SELECT Id, MasterLabel, VersionNumber, Status, DefinitionId
      FROM Flow 
      WHERE DefinitionId = '${definitionId}'
      ORDER BY VersionNumber DESC
      LIMIT 1
    `;
  
    const result = await tooling.query<any>(flowQuery);
    
    if (!result.records || result.records.length === 0) {
      return null;
    }
  
    const latestVersion = result.records[0];
  
    return {
      Id: definitionId, // The Container ID
      ApiName: flowApiName,
      Label: latestVersion.MasterLabel,
      VersionNumber: latestVersion.VersionNumber,
      Status: latestVersion.Status,
      LatestVersionId: latestVersion.Id, // The ID of the actual Flow version record
    } as FlowMetadata;
  }

  /**
   * Corrected getFlowDefinition
   * Retrieves the 'Metadata' field from the 'Flow' table
   */
  async getFlowDefinition(orgId: string, flowVersionId: string): Promise<unknown> {
    const conn = await this.authService.getConnection(orgId);
    const tooling = conn.tooling;

    // ERROR FIX: Table is 'Flow', Field is 'Metadata'
    const soql = `
      SELECT Metadata
      FROM Flow
      WHERE Id = '${flowVersionId}'
      LIMIT 1
    `;

    const result = await tooling.query<any>(soql);
    if (result.records.length === 0) {
      throw new Error(`Flow version not found for Id: ${flowVersionId}`);
    }

    // JSForce automatically parses the Metadata field into a JSON object.
    // You do NOT need JSON.parse() here usually.
    console.log(result)
    return result.records[0].Metadata; 
  }

  /**
   * Corrected getFlowVersions
   * Compares the passed Version ID with the immediate previous version
   */
  async getFlowVersions(orgId: string, flowApiName: string): Promise<{ current: unknown; previous: unknown }> {
    const flowMetadata = await this.getFlowMetadata(orgId, flowApiName);
    if (!flowMetadata) {
      throw new Error(`Flow not found: ${flowApiName}`);
    }

    // 1. Get Current Version Logic
    if (!flowMetadata.LatestVersionId) {
      throw new Error(`No latest version found for flow: ${flowApiName}`);
    }
    const currentVersion = await this.getFlowDefinition(orgId, flowMetadata.LatestVersionId);

    // 2. Get Previous Version Logic
    // We find the Flow record with the same DefinitionID but VersionNumber - 1
    const conn = await this.authService.getConnection(orgId);
    const tooling = conn.tooling;

    const previousVersionQuery = `
      SELECT Id, Metadata
      FROM Flow
      WHERE DefinitionId = '${flowMetadata.Id}' 
        AND VersionNumber = ${flowMetadata.VersionNumber - 1}
      LIMIT 1
    `;

    const previousResult = await tooling.query<any>(previousVersionQuery);
    let previousVersion: unknown = {};

    if (previousResult.records.length > 0) {
      previousVersion = previousResult.records[0].Metadata;
    }

    return {
      current: currentVersion,
      previous: previousVersion,
    };
  }

  /**
   * Analyze user permissions with natural language support
   * Supports both System Permissions (e.g., "export reports") and Object Permissions (e.g., "Edit Account")
   * Traces exactly which Profile or Permission Set grants the permission
   * 
   * @param orgId Salesforce Organization ID
   * @param userId User ID or Username
   * @param permissionQuery Natural language permission query (e.g., "export reports", "Edit Account", "Delete Lead") or API name
   * @returns Detailed permission analysis with sources
   */
  async analyzePermissions(
    orgId: string,
    userId: string,
    permissionQuery: string
  ): Promise<{
    username: string;
    userId: string;
    checkingPermission: string;
    resolvedLabel: string;
    hasAccess: boolean;
    sources: string[];
    explanation: string;
  }> {
    const conn = await this.authService.getConnection(orgId);

    // Router Logic: Detect query type
    // Pattern 1: Field Permission - "Action Object Field" (e.g., "Edit Account Description", "Read Contact Email")
    // Pattern 2: Object Permission - "Action Object" (e.g., "Edit Account", "Delete Lead")
    const fieldPermissionPattern = /^(read|create|edit|delete|viewall|modifyall|view all|modify all)\s+([a-zA-Z][a-zA-Z0-9_]*)\s+([a-zA-Z][a-zA-Z0-9_]*)$/i;
    const objectPermissionPattern = /^(read|create|edit|delete|viewall|modifyall|view all|modify all)\s+([a-zA-Z][a-zA-Z0-9_]*)$/i;
    
    const fieldMatch = permissionQuery.match(fieldPermissionPattern);
    const objectMatch = !fieldMatch ? permissionQuery.match(objectPermissionPattern) : null;

    // Step 2: Fetch User & Profile (needed for both paths)
    const userQuery = userId.includes('@')
      ? `SELECT Id, Username, Name, Email, ProfileId FROM User WHERE Username = '${userId.replace(/'/g, "''")}' LIMIT 1`
      : `SELECT Id, Username, Name, Email, ProfileId FROM User WHERE Id = '${userId.replace(/'/g, "''")}' LIMIT 1`;

    const userResult = await conn.query<any>(userQuery);

    if (!userResult.records || userResult.records.length === 0) {
      throw new Error(`User not found: ${userId}`);
    }

    const user = userResult.records[0];
    const profileId = user.ProfileId;

    if (!profileId) {
      throw new Error(`User ${user.Username} has no Profile assigned`);
    }

    // Get Profile name
    const profileQuery = `SELECT Id, Name FROM Profile WHERE Id = '${profileId.replace(/'/g, "''")}' LIMIT 1`;
    const profileResult = await conn.query<any>(profileQuery);
    const profileName = profileResult.records?.[0]?.Name || 'Unknown Profile';

    // Step 3: Fetch All Permission Sources (needed for both paths)
    const permissionSetAssignmentQuery = `
      SELECT PermissionSetId, PermissionSet.Name, PermissionSet.Label
      FROM PermissionSetAssignment
      WHERE AssigneeId = '${user.Id.replace(/'/g, "''")}'
    `;

    const permissionSetAssignmentResult = await conn.query<any>(permissionSetAssignmentQuery);
    const assignedPermissionSetIds: string[] = permissionSetAssignmentResult.records.map(
      (record: any) => record.PermissionSetId
    );

    // Get Profile-owned Permission Set ID
    const profilePermissionSetQuery = `
      SELECT Id, Name, Label, ProfileId
      FROM PermissionSet
      WHERE ProfileId = '${profileId.replace(/'/g, "''")}'
      LIMIT 1
    `;

    let profilePermissionSetId: string | null = null;
    try {
      const profilePermissionSetResult = await conn.query<any>(profilePermissionSetQuery);
      if (profilePermissionSetResult.records && profilePermissionSetResult.records.length > 0) {
        profilePermissionSetId = profilePermissionSetResult.records[0].Id;
      } else {
        profilePermissionSetId = profileId;
      }
    } catch (error) {
      profilePermissionSetId = profileId;
    }

    // Combine all Permission Set IDs
    const allPermissionSetIds: string[] = [];
    if (profilePermissionSetId) {
      allPermissionSetIds.push(profilePermissionSetId);
    }
    assignedPermissionSetIds.forEach(id => {
      if (!allPermissionSetIds.includes(id)) {
        allPermissionSetIds.push(id);
      }
    });

    if (allPermissionSetIds.length === 0) {
      return {
        username: user.Name,
        userId: user.Id,
        checkingPermission: permissionQuery,
        resolvedLabel: permissionQuery,
        hasAccess: false,
        sources: [],
        explanation: `User ${user.Name} has no Permission Sets or Profile assigned.`,
      };
    }

    // Router: Handle Field Permission vs Object Permission vs System Permission
    if (fieldMatch) {
      // Field Permission path: "Action Object Field"
      const action = fieldMatch[1];
      const objectName = fieldMatch[2];
      const fieldName = fieldMatch[3];
      
      try {
        const fieldResult = await this.checkFieldPermission(
          conn,
          objectName,
          fieldName,
          allPermissionSetIds
        );

        const hasAccess = action.toLowerCase() === 'read' ? fieldResult.canRead : 
                         action.toLowerCase() === 'edit' ? fieldResult.canEdit : false;
        
        const sources = action.toLowerCase() === 'read' ? fieldResult.sources.read :
                       action.toLowerCase() === 'edit' ? fieldResult.sources.edit : [];
        
        const resolvedLabel = `${this.mapActionToFieldName(action)} ${fieldResult.resolvedField.label} on ${objectName}`;
        
        let explanation: string;
        if (hasAccess) {
          if (sources.length === 1) {
            explanation = `User can ${action.toLowerCase()} ${fieldResult.resolvedField.label} on ${objectName} because it is granted by: ${sources[0]}`;
          } else {
            explanation = `User can ${action.toLowerCase()} ${fieldResult.resolvedField.label} on ${objectName} because it is granted by: ${sources.join(', ')}`;
          }
        } else {
          explanation = `User does NOT have permission to ${action.toLowerCase()} ${fieldResult.resolvedField.label} on ${objectName}. ` +
            `Checked ${allPermissionSetIds.length} Permission Set(s) including Profile "${profileName}".`;
        }

        return {
          username: user.Name,
          userId: user.Id,
          checkingPermission: `Permissions${this.mapActionToFieldName(action)} on ${objectName}.${fieldResult.resolvedField.apiName}`,
          resolvedLabel,
          hasAccess,
          sources,
          explanation,
        };
      } catch (error) {
        throw error;
      }
    } else if (objectMatch) {
      // Object Permission path: "Action Object" - Returns ALL CRUD rights summary
      const action = objectMatch[1];
      const objectName = objectMatch[2];
      
      try {
        const objectResult = await this.checkObjectPermission(
          conn,
          objectName,
          allPermissionSetIds
        );

        // Check if user has the specific action requested
        const hasAccess = objectResult.crudRights.includes(this.mapActionToFieldName(action));
        const sources = objectResult.sources[this.mapActionToFieldName(action)] || [];
        
        const resolvedLabel = `${this.mapActionToFieldName(action)} ${objectName}`;
        
        let explanation: string;
        if (hasAccess) {
          if (sources.length === 1) {
            explanation = `User can ${action.toLowerCase()} ${objectName} because it is granted by: ${sources[0]}`;
          } else {
            explanation = `User can ${action.toLowerCase()} ${objectName} because it is granted by: ${sources.join(', ')}`;
          }
          
          // Add summary of ALL CRUD rights
          if (objectResult.crudRights.length > 1) {
            explanation += ` User has [${objectResult.crudRights.join(', ')}] access to ${objectName}. Would you like to check access to a specific field on this object?`;
          }
        } else {
          explanation = `User does NOT have permission to ${action.toLowerCase()} ${objectName}. ` +
            `Checked ${allPermissionSetIds.length} Permission Set(s) including Profile "${profileName}".`;
          
          // Still show what rights they DO have
          if (objectResult.crudRights.length > 0) {
            explanation += ` However, user has [${objectResult.crudRights.join(', ')}] access to ${objectName}.`;
          }
        }

        return {
          username: user.Name,
          userId: user.Id,
          checkingPermission: `Permissions${this.mapActionToFieldName(action)} on ${objectName}`,
          resolvedLabel,
          hasAccess,
          sources,
          explanation,
        };
      } catch (error) {
        throw error;
      }
    } else {
      // System Permission path
      const resolvedPermission = await this.resolveSystemPermissionField(conn, permissionQuery);
      
      if (!resolvedPermission) {
        throw new Error(
          `Could not find a System Permission matching '${permissionQuery}'. ` +
          `Please check the spelling or use the exact API name (e.g., PermissionsExportReport). ` +
          `For Object Permissions, use format: "Action Object" (e.g., "Edit Account", "Delete Lead").`
        );
      }
      
      // Validate that the resolved permission looks like a valid API name
      if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(resolvedPermission.apiName)) {
        throw new Error(`Invalid permission name: ${resolvedPermission.apiName}. Permission names must start with a letter and contain only alphanumeric characters and underscores.`);
      }

    // Step 2: Fetch User & Profile
    const userQuery = userId.includes('@')
      ? `SELECT Id, Username, Name, Email, ProfileId FROM User WHERE Username = '${userId.replace(/'/g, "''")}' LIMIT 1`
      : `SELECT Id, Username, Name, Email, ProfileId FROM User WHERE Id = '${userId.replace(/'/g, "''")}' LIMIT 1`;

    const userResult = await conn.query<any>(userQuery);

    if (!userResult.records || userResult.records.length === 0) {
      throw new Error(`User not found: ${userId}`);
    }

    const user = userResult.records[0];
    const profileId = user.ProfileId;

    if (!profileId) {
      throw new Error(`User ${user.Username} has no Profile assigned`);
    }

    // Get Profile name
    const profileQuery = `SELECT Id, Name FROM Profile WHERE Id = '${profileId.replace(/'/g, "''")}' LIMIT 1`;
    const profileResult = await conn.query<any>(profileQuery);
    const profileName = profileResult.records?.[0]?.Name || 'Unknown Profile';

    // Step 3: Fetch All Permission Sources
    // Get all Permission Set IDs assigned to the user
    const permissionSetAssignmentQuery = `
      SELECT PermissionSetId, PermissionSet.Name, PermissionSet.Label
      FROM PermissionSetAssignment
      WHERE AssigneeId = '${user.Id.replace(/'/g, "''")}'
    `;

    const permissionSetAssignmentResult = await conn.query<any>(permissionSetAssignmentQuery);
    const assignedPermissionSetIds: string[] = permissionSetAssignmentResult.records.map(
      (record: any) => record.PermissionSetId
    );

    // Get Profile-owned Permission Set ID
    // Profiles are Permission Sets with IsOwnedByProfile = true
    // Query PermissionSet where ProfileId matches the user's ProfileId
    const profilePermissionSetQuery = `
      SELECT Id, Name, Label, ProfileId
      FROM PermissionSet
      WHERE ProfileId = '${profileId.replace(/'/g, "''")}'
      LIMIT 1
    `;

    let profilePermissionSetId: string | null = null;
    try {
      const profilePermissionSetResult = await conn.query<any>(profilePermissionSetQuery);
      if (profilePermissionSetResult.records && profilePermissionSetResult.records.length > 0) {
        profilePermissionSetId = profilePermissionSetResult.records[0].Id;
      } else {
        // Fallback: Profiles are PermissionSets, so ProfileId can be used directly
        profilePermissionSetId = profileId;
      }
    } catch (error) {
      // Profile PermissionSet query might fail in some orgs, use ProfileId directly as fallback
      profilePermissionSetId = profileId;
    }

    // Combine all Permission Set IDs (assigned sets + profile set)
    const allPermissionSetIds: string[] = [];
    if (profilePermissionSetId) {
      allPermissionSetIds.push(profilePermissionSetId);
    }
    assignedPermissionSetIds.forEach(id => {
      if (!allPermissionSetIds.includes(id)) {
        allPermissionSetIds.push(id);
      }
    });

    if (allPermissionSetIds.length === 0) {
      return {
        username: user.Name,
        userId: user.Id,
        checkingPermission: permissionQuery,
        resolvedLabel: permissionQuery,
        hasAccess: false,
        sources: [],
        explanation: `User ${user.Name} has no Permission Sets or Profile assigned.`,
      };
    }

      // Step 4: The "Detective" Query for System Permissions
      // Check if any of the Permission Sets grant this System Permission
      const permissionSetIdsStr = allPermissionSetIds.map(id => `'${id.replace(/'/g, "''")}'`).join(', ');
      
      // Construct the field name safely (already validated above)
      const permissionField = resolvedPermission.apiName;
      
      // Query PermissionSet with IsOwnedByProfile and Profile.Name to identify Profile vs Permission Set
      const detectiveQuery = `
        SELECT Id, Name, Label, IsOwnedByProfile, Profile.Name, ${permissionField}
        FROM PermissionSet
        WHERE Id IN (${permissionSetIdsStr})
          AND ${permissionField} = true
      `;

      let hasAccess = false;
      const sources: string[] = [];

      try {
        const detectiveResult = await conn.query<any>(detectiveQuery);
        
        if (detectiveResult.records && detectiveResult.records.length > 0) {
          hasAccess = true;
          
          // Build sources list using IsOwnedByProfile and Profile.Name
          for (const record of detectiveResult.records) {
            const isOwnedByProfile = record.IsOwnedByProfile === true;
            const profileName = record.Profile?.Name;
            
            if (isOwnedByProfile && profileName) {
              // This is a Profile-owned Permission Set
              sources.push(`Profile: ${profileName}`);
            } else {
              // This is a regular Permission Set
              let displayName = record.Label || record.Name || 'Unknown';
              
              if (displayName === 'Unknown' || !record.Label) {
                const assignment = permissionSetAssignmentResult.records.find(
                  (a: any) => a.PermissionSetId === record.Id
                );
                displayName = assignment?.PermissionSet?.Label || assignment?.PermissionSet?.Name || displayName;
              }
              
              sources.push(`Permission Set: ${displayName}`);
            }
          }
        }
      } catch (error) {
        // If the field doesn't exist, the permission might not be a valid system permission
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        if (errorMessage.includes('INVALID_FIELD') || errorMessage.includes('No such column')) {
          throw new Error(
            `Permission field '${resolvedPermission.apiName}' does not exist. ` +
            `Please check the permission name or use a natural language query like "export reports". ` +
            `For Object Permissions, use format: "Action Object" (e.g., "Edit Account").`
          );
        }
        throw error;
      }

      // Step 5: Build Explanation for System Permissions
      let explanation: string;
      if (hasAccess) {
        if (sources.length === 1) {
          explanation = `User can do this because it is granted by: ${sources[0]}`;
        } else {
          explanation = `User can do this because it is granted by: ${sources.join(', ')}`;
        }
      } else {
        explanation = `User does NOT have access to "${permissionQuery}". ` +
          `Checked ${allPermissionSetIds.length} Permission Set(s) including Profile "${profileName}".`;
      }

      return {
        username: user.Name,
        userId: user.Id,
        checkingPermission: resolvedPermission.apiName,
        resolvedLabel: resolvedPermission.label,
        hasAccess,
        sources,
        explanation,
      };
    }
  }

  // ... getManagedContent remains the same
}