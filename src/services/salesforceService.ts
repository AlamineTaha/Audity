import { SalesforceAuthService } from './authService';
import { FlowMetadata, SetupAuditTrail } from '../types';

export class SalesforceService {
  private authService: SalesforceAuthService;

  constructor(authService: SalesforceAuthService) {
    this.authService = authService;
  }

  /**
   * Resolve permission field name dynamically using Tooling API
   * Queries FieldDefinition to find the correct API name based on user input
   * 
   * @param conn jsforce Connection instance
   * @param userQuery Natural language permission query or API name
   * @returns The QualifiedApiName (e.g., 'PermissionsExportReport') or null if not found
   */
  private async resolvePermissionField(conn: any, userQuery: string): Promise<string | null> {
    const tooling = conn.tooling;
    
    // Escape single quotes to prevent SOQL injection
    const escapedQuery = userQuery.replace(/'/g, "''");
    
    // Query FieldDefinition table using Tooling API
    // Search by both Label (natural language) and QualifiedApiName (exact match)
    const fieldDefinitionQuery = `
      SELECT QualifiedApiName, Label
      FROM FieldDefinition
      WHERE EntityDefinition.QualifiedApiName = 'PermissionSet'
        AND (
          Label LIKE '%${escapedQuery}%'
          OR QualifiedApiName = '${escapedQuery}'
          OR QualifiedApiName LIKE '%${escapedQuery}%'
        )
        AND QualifiedApiName LIKE 'Permissions%'
      ORDER BY QualifiedApiName
      LIMIT 1
    `;

    try {
      const result = await tooling.query(fieldDefinitionQuery);
      
      if (result.records && result.records.length > 0) {
        return (result.records[0] as any).QualifiedApiName;
      }
      
      return null;
    } catch (error) {
      console.error('Error resolving permission field:', error);
      // If Tooling API query fails, return null to let caller handle it
      return null;
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
   * Traces exactly which Profile or Permission Set grants a specific system permission
   * 
   * @param orgId Salesforce Organization ID
   * @param userId User ID or Username
   * @param permissionQuery Natural language permission query (e.g., "export reports") or API name
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
    hasAccess: boolean;
    sources: string[];
    explanation: string;
  }> {
    const conn = await this.authService.getConnection(orgId);

    // Step 1: Resolve the Permission Name using Tooling API
    const resolvedPermission = await this.resolvePermissionField(conn, permissionQuery);
    
    if (!resolvedPermission) {
      throw new Error(
        `Could not find a System Permission matching '${permissionQuery}'. ` +
        `Please check the spelling or use the exact API name (e.g., PermissionsExportReport).`
      );
    }
    
    // Validate that the resolved permission looks like a valid API name
    // Prevent SOQL injection by ensuring it matches expected pattern
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(resolvedPermission)) {
      throw new Error(`Invalid permission name: ${resolvedPermission}. Permission names must start with a letter and contain only alphanumeric characters and underscores.`);
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

    // Get Profile's Permission Set ID (Profiles are hidden Permission Sets)
    // In Salesforce, Profiles have a corresponding PermissionSet record
    const profilePermissionSetQuery = `
      SELECT Id, Name, Label
      FROM PermissionSet
      WHERE Id = '${profileId.replace(/'/g, "''")}'
      LIMIT 1
    `;

    let profilePermissionSetId: string | null = null;
    try {
      const profilePermissionSetResult = await conn.query<any>(profilePermissionSetQuery);
      if (profilePermissionSetResult.records && profilePermissionSetResult.records.length > 0) {
        profilePermissionSetId = profilePermissionSetResult.records[0].Id;
      }
    } catch (error) {
      // Profile PermissionSet query might fail in some orgs, try alternative approach
      // Profiles are PermissionSets, so we can use ProfileId directly
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
        checkingPermission: resolvedPermission,
        hasAccess: false,
        sources: [],
        explanation: `User ${user.Name} has no Permission Sets or Profile assigned.`,
      };
    }

    // Step 4: The "Detective" Query
    // Check if any of the Permission Sets grant this permission
    const permissionSetIdsStr = allPermissionSetIds.map(id => `'${id.replace(/'/g, "''")}'`).join(', ');
    
    // Construct the field name safely (already validated above)
    const permissionField = resolvedPermission;
    
    const detectiveQuery = `
      SELECT Id, Name, Label, ${permissionField}
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
        
        // Build sources list
        for (const record of detectiveResult.records) {
          const setName = record.Label || record.Name || 'Unknown';
          const isProfile = record.Id === profilePermissionSetId;
          
          if (isProfile) {
            sources.push(`Profile: ${setName}`);
          } else {
            // Find the assignment record to get the Permission Set name
            const assignment = permissionSetAssignmentResult.records.find(
              (a: any) => a.PermissionSetId === record.Id
            );
            const displayName = assignment?.PermissionSet?.Label || assignment?.PermissionSet?.Name || setName;
            sources.push(`Permission Set: ${displayName}`);
          }
        }
      }
    } catch (error) {
      // If the field doesn't exist, the permission might not be a valid system permission
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      if (errorMessage.includes('INVALID_FIELD') || errorMessage.includes('No such column')) {
        throw new Error(
          `Permission field '${resolvedPermission}' does not exist. ` +
          `Please check the permission name or use a natural language query like "export reports".`
        );
      }
      throw error;
    }

    // Step 5: Build Explanation
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
      checkingPermission: resolvedPermission,
      hasAccess,
      sources,
      explanation,
    };
  }

  // ... getManagedContent remains the same
}