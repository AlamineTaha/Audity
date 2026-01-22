import * as jsforce from 'jsforce';
import { SalesforceAuthService } from './authService';
import { FlowMetadata, SetupAuditTrail } from '../types';

export class SalesforceService {
  private authService: SalesforceAuthService;

  constructor(authService: SalesforceAuthService) {
    this.authService = authService;
  }

  // ... queryAuditTrail remains mostly the same, 
  // but note: 'ChangedFlow' might need to be 'flowChanged' or similar depending on the org's locale/version.

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

  // ... getManagedContent remains the same
}