/**
 * Dependency Service
 * Manages manual dependency mappings uploaded by admins
 * Stores mappings of Apex Classes/LWCs to Flows without scanning code
 */

interface DependencyMapping {
  flowApiName: string;
  dependencies: Array<{
    type: 'Apex Class' | 'LWC' | 'Flow' | 'Process Builder' | 'Other';
    name: string;
    description?: string;
  }>;
}

export class DependencyService {
  private dependencyMap: Map<string, DependencyMapping['dependencies']>;

  constructor() {
    this.dependencyMap = new Map();
    // Initialize with empty map - can be populated via upload methods
  }

  /**
   * Upload dependency mappings from JSON
   * Expected format: Array of { flowApiName, dependencies: [{ type, name, description? }] }
   * 
   * @param mappings Array of dependency mappings
   */
  uploadDependencyMappings(mappings: DependencyMapping[]): void {
    for (const mapping of mappings) {
      this.dependencyMap.set(mapping.flowApiName.toLowerCase(), mapping.dependencies);
    }
  }

  /**
   * Upload dependency mappings from CSV string
   * Expected format: flowApiName,type,name,description
   * 
   * @param csvString CSV string with headers
   */
  uploadDependencyMappingsFromCSV(csvString: string): void {
    const lines = csvString.split('\n').filter(line => line.trim());
    if (lines.length < 2) {
      return; // Need at least header + one data row
    }

    const headers = lines[0].split(',').map(h => h.trim().toLowerCase());
    const flowApiNameIndex = headers.indexOf('flowapiname');
    const typeIndex = headers.indexOf('type');
    const nameIndex = headers.indexOf('name');
    const descriptionIndex = headers.indexOf('description');

    if (flowApiNameIndex === -1 || typeIndex === -1 || nameIndex === -1) {
      throw new Error('CSV must contain columns: flowApiName, type, name');
    }

    const mappingsMap = new Map<string, DependencyMapping['dependencies']>();

    for (let i = 1; i < lines.length; i++) {
      const values = lines[i].split(',').map(v => v.trim());
      const flowApiName = values[flowApiNameIndex];
      const type = values[typeIndex] as DependencyMapping['dependencies'][0]['type'];
      const name = values[nameIndex];
      const description = descriptionIndex !== -1 ? values[descriptionIndex] : undefined;

      if (!flowApiName || !type || !name) {
        continue; // Skip invalid rows
      }

      if (!mappingsMap.has(flowApiName.toLowerCase())) {
        mappingsMap.set(flowApiName.toLowerCase(), []);
      }

      mappingsMap.get(flowApiName.toLowerCase())!.push({
        type,
        name,
        description,
      });
    }

    // Merge with existing mappings
    for (const [flowApiName, deps] of mappingsMap.entries()) {
      const existing = this.dependencyMap.get(flowApiName) || [];
      this.dependencyMap.set(flowApiName, [...existing, ...deps]);
    }
  }

  /**
   * Get manual dependencies for a specific Flow
   * 
   * @param flowApiName Flow API name
   * @returns Array of dependencies
   */
  getManualDependencies(flowApiName: string): Array<{
    type: string;
    name: string;
    description?: string;
  }> {
    return this.dependencyMap.get(flowApiName.toLowerCase()) || [];
  }

  /**
   * Get all dependency mappings
   * 
   * @returns Map of flowApiName to dependencies
   */
  getAllDependencies(): Map<string, DependencyMapping['dependencies']> {
    return new Map(this.dependencyMap);
  }

  /**
   * Clear all dependency mappings
   */
  clearDependencies(): void {
    this.dependencyMap.clear();
  }

  /**
   * Remove dependencies for a specific Flow
   * 
   * @param flowApiName Flow API name
   */
  removeDependencies(flowApiName: string): void {
    this.dependencyMap.delete(flowApiName.toLowerCase());
  }
}
