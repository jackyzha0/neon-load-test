import { customAlphabet } from 'nanoid';
import postgres from 'postgres';
import fs from 'fs';
import type { NeonProjectMetadata, NeonRegion, NeonApiClient } from './neon';
import { apiClient, clearAllProjects } from './neon';
import { failureStats, random, scheduleAtRate } from './util';
import { prettyPrintError, logger } from './logger';
import { Mutex } from 'async-mutex';
import { EndpointType } from '@neondatabase/api-client';
import v8 from "node:v8";

const db = (uri: string) => postgres(uri, {
  connect_timeout: 150,
  connection: {
    application_name: 'project-load-test',
  }
});

const nanoid = customAlphabet('0123456789abcdef', 6);

class NeonProject {
  metadata?: NeonProjectMetadata;

  mutex = new Mutex();

  checkpointBranches: Set<string> = new Set();
  previewBranches: Set<string> = new Set();

  mainDbUri?: string;
  mainBranchId?: string;

  constructor(private apiClient: NeonApiClient) {
    this.apiClient = apiClient;
  }

  async init(region: NeonRegion = 'aws-us-east-2') {
    const name = `project-load-${nanoid()}`;
    logger.debug(`${name}: project init`)

    const res = await this.apiClient.createProject({
      project: { name, region_id: region },
    });

    const defaultRole = res.data.roles.at(0);
    if (defaultRole === undefined) {
      throw new Error('no roles returned from project creation');
    }

    const defaultDb = res.data.databases.at(0);
    if (defaultDb === undefined) {
      throw new Error('no databases returned from project creation');
    }

    this.mainBranchId = res.data.branch.id;

    const projectId = res.data.project.id;
    const roleName = defaultRole.name;
    const dbName = defaultDb.name;

    logger.debug(`${name}: pinging main compute`)
    const uriRes = await this.apiClient.getConnectionUri({
      projectId,
      database_name: dbName,
      role_name: roleName,
    })

    const uri = uriRes.data.uri
    const sql = db(uri);
    this.mainDbUri = uri;
    await sql`CREATE TABLE IF NOT EXISTS users (id SERIAL PRIMARY KEY, name VARCHAR(255));`;
    await sql`INSERT INTO users (name) VALUES ('test_user_init') RETURNING id, name;`;
    const result = await sql`SELECT * FROM users;`;
    await sql.end();


    if (result.length === 0) {
      throw new Error('ping failed, unexpected result');
    }

    this.metadata = {
      projectId,
      name,
      roleName,
      region,
      dbName,
    };

  }

  startDoingThings(options: Options) {
    const { perProject } = options.rpm;

    scheduleAtRate(
      async () => {
        if (!this.mainDbUri) return;
        await this.writeUser(this.mainDbUri);
      },
      perProject.writes,
      (error) => {
        failureStats.action.write++;
        prettyPrintError("error writing user", error);
      }
    )

    scheduleAtRate(
      this.createCheckpoint.bind(this),
      perProject.checkpoints,
      (error) => {
        failureStats.action.checkpoint++;
        prettyPrintError("error creating checkpoint", error);
      }
    )

    scheduleAtRate(
      async () => {
        if (this.checkpointBranches.size === 0) return;
        await this.createPreview(random(Array.from(this.checkpointBranches)));
      },
      perProject.previews,
      (error) => {
        failureStats.action.preview++;
        prettyPrintError("error creating preview", error);
      }
    )

    scheduleAtRate(
      async () => {
        if (this.checkpointBranches.size === 0) return;
        await this.rollback(random(Array.from(this.checkpointBranches)));
      },
      perProject.rollbacks,
      (error) => {
        failureStats.action.rollback++;
        prettyPrintError("error rolling back", error);
      }
    )
  }

  async writeUser(dbUri: string) {
    logger.debug(`${this.metadata?.name}: writing user`)
    await this.mutex.runExclusive(async () => {
      if (!this.metadata) {
        throw new Error('project not initialized');
      }

      const name = `test_user_${nanoid()}`;
      const sql = db(dbUri);
      await sql`INSERT INTO users (name) VALUES (${name}) RETURNING id, name;`;
      await sql.end();
    });
  }

  async createCheckpoint() {
    logger.debug(`${this.metadata?.name}: creating checkpoint`)
    await this.mutex.runExclusive(async () => {
      if (!this.metadata) {
        throw new Error('project not initialized');
      }

      const res = await this.apiClient.createProjectBranch(this.metadata.projectId, {
        branch: {
          name: `checkpoint-${nanoid()}`,
          archived: true,
        },
      })

      this.checkpointBranches.add(res.data.branch.id);
    });
  }

  async createPreview(branchId: string) {
    logger.debug(`${this.metadata?.name}: creating preview of ${branchId}`)

    await this.mutex.runExclusive(async () => {
      if (!this.metadata || !this.mainDbUri) {
        throw new Error('project not initialized');
      }

      const res = await this.apiClient.createProjectBranch(this.metadata.projectId, {
        branch: {
          name: `preview-${nanoid()}`,
          parent_id: branchId,
        },
        endpoints: [{ type: EndpointType.ReadWrite }]
      })

      this.previewBranches.add(res.data.branch.id);

      const previewEndpoint = res.data.endpoints.at(0);
      if (previewEndpoint === undefined) {
        throw new Error('no endpoints returned from preview creation');
      }

      const uri = new URL(this.mainDbUri);
      uri.host = previewEndpoint.host;
      const sql = db(uri.toString());
      await sql`SELECT * FROM users;`;
      await sql.end();
    });
  }

  async rollback(branchId: string) {
    logger.debug(`${this.metadata?.name}: rolling back to ${branchId}`)
    await this.mutex.runExclusive(async () => {
      if (!this.metadata || !this.mainBranchId) {
        throw new Error('project not initialized');
      }

      const preserveName = `main-old-${nanoid()}`;
      await this.apiClient.restoreProjectBranch(this.metadata.projectId, this.mainBranchId, {
        source_branch_id: branchId,
        preserve_under_name: preserveName,
      })

      // the id returned on this branch isnt accurate, we need to list and find the one with the preserve name
      const branchesRes = await this.apiClient.listProjectBranches({ projectId: this.metadata.projectId });
      const preservedBranch = branchesRes.data.branches.find(b => b.name === preserveName);
      if (preservedBranch === undefined) {
        throw new Error('preserved branch not found');
      }

      this.mainBranchId = preservedBranch.id;
    })
  }
}

type Options = {
  regions: NeonRegion[];
  numInitialProjects: number;
  rpm: {
    projects: number;
    perProject: {
      checkpoints: number;
      writes: number;
      rollbacks: number;
      previews: number;
    }
  };
}

function clearLogFiles() {
  const localFiles = fs.readdirSync('.')
  const logFiles = localFiles.filter(file => file.endsWith('.log'));
  const snapshotFiles = localFiles.filter(file => file.endsWith('.heapsnapshot'));

  for (const file of [...logFiles, ...snapshotFiles]) {
    try {
      if (fs.existsSync(file)) {
        fs.unlinkSync(file);
      }
    } catch (error) {
      // Ignore errors if file doesn't exist or can't be deleted
    }
  }
}

async function run(options: Options) {
  const projects: NeonProject[] = [];

  // Clear all log files at start of run
  clearLogFiles();

  // Set up ctrl+c handler to display summary
  const handleExit = async () => {
    const snapshotPath = v8.writeHeapSnapshot();
    logger.info(`heap snapshot written to: ${snapshotPath}`);
    process.exit(0);
  };

  process.on('SIGINT', handleExit);

  await clearAllProjects();
  logger.info('all projects cleared successfully.');

  await Promise.all(
    Array.from({ length: options.numInitialProjects }, async () => {
      const project = new NeonProject(apiClient);
      await project.init(random(options.regions));
      projects.push(project);
    })
  );

  logger.info(`created ${projects.length} projects successfully.`);

  logger.info('starting load test...');
  logger.info('press ctrl+c at any time to see test summary and exit.');

  for (const project of projects) {
    project.startDoingThings(options);
  }

  scheduleAtRate(
    async () => {
      const project = new NeonProject(apiClient);
      await project.init(random(options.regions));
      project.startDoingThings(options);
      projects.push(project);
    },
    options.rpm.projects,
    (error) => {
      failureStats.project++;
      prettyPrintError("error creating project", error);
    }
  );
}

/**
  * projects (project creation + 1 compute op)
  *   15/m
  * checkpoints (1 branch op)
  *   500/m
  * rollbacks (2 compute ops, one down one up)
  *   8/m
  * previews (1 branch + 1 compute op)
  *   6/m
  *
  * estimated rate multiple: 50x
  **/
const multiplier = 50;
try {
  await run({
    regions: ['aws-us-east-2'],
    numInitialProjects: 20,
    rpm: {
      projects: 15 * multiplier, // 15 base, we should multiply by 50 for the test
      perProject: {
        checkpoints: 1,
        writes: 10,
        rollbacks: 1 / 5, // 1 rollback every 5 minutes
        previews: 1 / 5, // 1 preview every 5 minutes
      }
    }
  });
} catch (error) {
  prettyPrintError("error during setup", error);
}
