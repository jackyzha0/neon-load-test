import { createApiClient } from '@neondatabase/api-client';

export type NeonRegion = 'aws-us-east-2' | 'azure-eastus2' | 'aws-eu-west-1';

export type NeonProjectMetadata = {
  projectId: string;
  name: string;
  roleName: string;
  region: NeonRegion;
  dbName: string;
}

if (!process.env.NEON_API_KEY) {
  throw new Error('NEON_API_KEY environment variable is not set.');
}

export const apiClient = createApiClient({
  apiKey: process.env.NEON_API_KEY,
  baseURL: 'https://console-stage.neon.build/api/v2',
});

// clear all projects
export async function clearAllProjects() {
  const projectIds = new Set<string>();
  let cursor: string | undefined = undefined;

  while (true) {
    const resp = await apiClient.listProjects({ cursor, limit: 400 });
    const projects = resp.data.projects;
    if (!projects || projects.length === 0) {
      break;
    }

    cursor = resp.data.pagination?.cursor;
    for (const project of projects) {
      if (project.name.startsWith('project-load')) {
        projectIds.add(project.id);
      }
    }
  }

  for (const projectId of projectIds) {
    await apiClient.deleteProject(projectId);
  }
}
  

export type NeonApiClient = typeof apiClient; 
