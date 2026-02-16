import { Connection, Client } from '@temporalio/client'
import { Worker, NativeConnection } from '@temporalio/worker'
import type {
  WorkflowExecutionInfo,
  SearchAttributes,
  SignalDefinition,
} from '@temporalio/client'
import config from '../../config'
import { getTimestampUTC, type Database, type Timespan } from '../database'
import { log } from '../../util/functions'
import { Address, BufferUtil, Networks } from 'xpi-ts/lib/bitcore'
import { RankTopPost, RankTopProfile } from '../api'

/**
 * Temporal client and worker wrapper class for managing workflow executions
 * and database interactions.
 */
export class Temporal {
  /** Temporal client for managing workflow executions */
  client!: Client
  /** Temporal worker for executing activities and workflows */
  worker!: Worker
  /** Database instance for data persistence */
  db: Database

  /**
   * Creates a new Temporal instance with the specified database connection
   * @param db - The Database instance for data persistence
   */
  constructor(db: Database) {
    this.db = db
  }

  /**
   * Initializes the Temporal client and worker connections.
   * Sets up the connection to the Temporal server using configuration
   * from environment variables and prepares the worker for task execution.
   * @throws Will log a warning if Temporal connection fails
   */
  async init() {
    // set up Temporal client and worker if complete configuration exists
    if (
      !Object.values(config.temporal).some(v => v === undefined || v === '')
    ) {
      try {
        // Temporal client
        this.client = new Client({
          connection: await Connection.connect({
            address: config.temporal.host,
          }),
          namespace: config.temporal.namespace,
        })
        // Temporal worker
        const activities = {
          ...this.activities,
          ...this.localActivities,
        }
        this.worker = await Worker.create({
          connection: await NativeConnection.connect({
            address: config.temporal.host,
          }),
          namespace: config.temporal.namespace,
          taskQueue: config.temporal.taskQueue,
          activities,
          workflowBundle: {
            codePath: require.resolve('./temporal/workflows'),
          },
        })
        this.worker.run()
      } catch (e) {
        log([
          ['init', 'temporal'],
          ['status', 'warn'],
          ['message', `"${String(e)}"`],
        ])
      }
    }
  }

  /**
   * Closes the Temporal client and worker connections.
   * @throws Will log a warning if Temporal connection fails
   */
  async close() {
    await this.client?.connection.close()
    this.worker?.shutdown()
  }

  /**
   * Temporal Activity definitions (must be arrow functions)
   */
  activities = {
    /**
     * List all workflows matching the query and return the workflow execution info
     * @param query - The SQL-like query to list workflows
     * @returns The list of workflow executions
     */
    listWorkflows: async ({ query }: { query: string }) => {
      const queryResult = this.client.workflow.list({ query })
      const workflowList: WorkflowExecutionInfo[] = []
      for await (const workflowInfo of queryResult) {
        workflowList.push(workflowInfo)
      }
      return workflowList
    },

    /**
     * Get the result of a workflow execution
     * @param workflowId - The ID of the workflow for which to get the result
     * @returns The result of the workflow execution
     */
    resultWorkflow: async ({
      workflowId,
      runId,
    }: {
      workflowId: string
      runId?: string
    }) => {
      return await this.client.workflow.result(workflowId, runId, {
        followRuns: true,
      })
    },

    /**
     * Query a Temporal workflow, returning the query result
     * @param workflowId - The ID of the workflow for which to query
     * @param queryType - The type of query to execute
     * @returns The query result
     */
    queryWorkflow: async ({
      workflowId,
      queryType,
    }: {
      workflowId: string
      queryType: string
    }) => {
      const handle = this.client.workflow.getHandle(workflowId)
      return await handle.query(queryType)
    },

    /**
     * Start a Temporal workflow, returning a handle to the workflow
     * @param param0 - Workflow type, taskQueue, workflowId, searchAttributes, and args
     * @returns Workflow handle
     */
    startWorkflow: async ({
      taskQueue,
      workflowType,
      workflowId,
      searchAttributes,
      args,
    }: {
      taskQueue: string
      workflowType: string
      workflowId: string
      searchAttributes?: SearchAttributes
      args?: unknown[]
    }) => {
      return await this.client.workflow.start(workflowType, {
        taskQueue,
        workflowId,
        searchAttributes,
        args,
      })
    },

    /**
     * Signal a Temporal workflow, returning a handle to the workflow
     * @param param0 - Workflow type, taskQueue, workflowId, args, signal, and signalArgs
     * @returns Workflow handle
     */
    signalWithStart: async ({
      taskQueue,
      workflowType,
      workflowId,
      args,
      signal,
      signalArgs,
    }: {
      taskQueue: string
      workflowType: string
      workflowId: string
      args?: unknown[]
      signal: string | SignalDefinition
      signalArgs?: unknown[]
    }) => {
      return await this.client.workflow.signalWithStart(workflowType, {
        taskQueue,
        workflowId,
        args,
        signal,
        signalArgs,
      })
    },

    /**
     * Retrieves the activity for a wallet rank based on the provided script payload and optional time range.
     * @param scriptPayload - The script payload to get activity for
     * @param startTime - The start time to get activity for
     * @param endTime - The end time to get activity for
     * @returns Wallet rank activity
     */
    getWalletRankActivity: async (
      scriptPayload: string,
      startTime?: Timespan,
      endTime?: Timespan,
    ) => {
      if (!startTime) {
        startTime = 'today'
      }
      if (!endTime) {
        endTime = 'now'
      }
      const address = Address.fromPublicKeyHash(
        BufferUtil.from(scriptPayload, 'hex'),
        Networks.mainnet,
      )
      const activity = await this.db.ipcGetScriptPayloadActivity(
        {
          startTime,
          endTime,
          scriptPayload,
        },
        'api',
      )
      return {
        address: address.toXAddress(),
        activity,
      }
    },

    /**
     * Retrieves the activity summary for a wallet rank based on the provided script payload and optional time range.
     * @param startTime - The start time to get activity for
     * @param endTime - The end time to get activity for
     * @returns Wallet rank activity summary
     */
    getWalletRankActivitySummary: async (
      startTime: Timespan,
      endTime?: Timespan,
    ) => {
      return await this.db.ipcGetScriptPayloadActivitySummary({
        startTime,
        endTime,
      })
    },

    /**
     * Retrieves the top ranked profiles of all time.
     * @returns Top ranked profiles
     */
    getAllTimeTopRankedProfiles: async (): Promise<RankTopProfile[]> => {
      return await this.db.getStatsPlatformRanked({
        dataType: 'profileId',
        rankingType: 'top',
        startTime: 'all',
      })
    },

    /**
     * Retrieves the top ranked profiles for a platform based on the provided time range.
     * @param startTime - The start time to get profiles for
     * @returns Top ranked profiles
     */
    getTopRankedProfiles: async (
      startTime: Timespan,
    ): Promise<RankTopProfile[]> => {
      return await this.db.getStatsPlatformRanked({
        dataType: 'profileId',
        rankingType: 'top',
        startTime,
      })
    },

    /**
     * Retrieves the top ranked posts for a platform based on the provided time range.
     * @param startTime - The start time to get posts for
     * @returns Top ranked posts
     */
    getTopRankedPosts: async (startTime: Timespan): Promise<RankTopPost[]> => {
      return await this.db.getStatsPlatformRanked({
        dataType: 'postId',
        rankingType: 'top',
        startTime,
      })
    },
    //getRankedProfile: this.db.apiGetPlatformProfile,
    //getRankedPost: this.db.apiGetPlatformProfilePost,
  }
  /**
   * Local activity definitions for Temporal workflows.
   * These are lightweight, fast-executing activities that run in the workflow's process.
   */

  localActivities = {
    /**
     * Async wrapper for `getTimestampUTC`
     */
    getTimestampUTC: async (timespan: Timespan) => {
      return getTimestampUTC(timespan)
    },
  }
}
