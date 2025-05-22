/* eslint-disable @typescript-eslint/no-duplicate-enum-values */
import { Server } from 'node:http'
import { EventEmitter } from 'node:events'
import express, {
  Express,
  Router,
  Request,
  Response,
  NextFunction,
  json,
} from 'express'
import {
  Connection,
  Client as TemporalClient,
  type SearchAttributes,
  type SignalDefinition,
  type WorkflowExecutionInfo,
} from '@temporalio/client'
import { Worker as TemporalWorker, NativeConnection } from '@temporalio/worker'
import { Address, Message, Networks } from 'bitcore-lib-xpi'
import {
  PLATFORMS,
  log,
  type ScriptChunkPlatformUTF8,
  type InstanceData,
  type AuthorizationData,
  API as API_LIB,
  Util,
  Block,
  LogEntry,
} from 'rank-lib'
import RuntimeState from './state'
import Database, { type Timespan } from './database'
import config from '../config'
import {
  API_AUTH_CACHE_ENTRY_TTL,
  API_SERVER_PORT,
  ERR,
  HTTP,
} from '../util/constants'
import { isValidInstanceId } from '../util/functions'

/**
 * Represents a profile's ranking information including total and change metrics
 * @typedef {Object} RankTopProfile
 * @property {Object} total - Overall ranking statistics
 * @property {string} total.ranking - The total ranking score
 * @property {number} total.votesPositive - Total number of positive votes received
 * @property {number} total.votesNegative - Total number of negative votes received
 * @property {Object} changed - Metrics showing ranking changes
 * @property {string} changed.ranking - The change in ranking score
 * @property {string} changed.rate - The rate of change
 * @property {number} changed.votesPositive - Number of new positive votes
 * @property {number} changed.votesNegative - Number of new negative votes
 * @property {string[]} votesTimespan - Array of timestamps for vote history
 * @property {string} profileId - Unique identifier for the profile
 * @property {'twitter'} platform - The social media platform (currently only Twitter)
 */
export type RankTopProfile = {
  total: {
    ranking: string
    votesPositive: number
    votesNegative: number
  }
  changed: {
    ranking: string
    rate: string
    votesPositive: number
    votesNegative: number
  }
  votesTimespan: string[]
  profileId: string
  platform: 'twitter'
}
/**
 * Represents a post's ranking information, extending RankTopProfile with an optional postId
 * @typedef {Object} RankTopPost
 * @extends {RankTopProfile}
 * @property {string} [postId] - Optional unique identifier for the post
 */
export type RankTopPost = RankTopProfile & {
  postId?: string
}
/**
 * Represents an entry in the authentication cache for an extension instance
 * @property {string} authDataStr - Stringified `AuthorizationData` object
 * @property {number} expiresAt - Block height at which the instance authorization will expire
 */
type AuthCacheEntry = {
  /** Stringified `AuthorizationData` object */
  authDataStr: string
  /** Block height at which the instance authorization will expire */
  expiresAt: number
}
/** Runtime cache of authenticated instances, where string is the instanceId*/
type AuthCache = Map<string, AuthCacheEntry>
type Endpoint = 'profile' | 'post' | 'stats' | 'instance' | 'wallet'
type EndpointHandler = (req: Request, res: Response) => void
type EndpointParameter =
  | 'platform'
  | 'profileId'
  | 'postId'
  | 'scriptPayload'
  | 'statsRoute'
  | 'pageNum'
  | 'instanceId'
type EndpointParameterHandler = (
  req: Request,
  res: Response,
  next: NextFunction,
  param: string | undefined,
) => void

enum StatsRoutes {
  'profiles/top-ranked' = 'getStatsPlatformRanked',
  'profiles/lowest-ranked' = 'getStatsPlatformRanked',
  'posts/top-ranked' = 'getStatsPlatformRanked',
  'posts/lowest-ranked' = 'getStatsPlatformRanked',
}
type StatsRoute = keyof typeof StatsRoutes

/**
 * API class for handling HTTP requests and responses
 * @extends {EventEmitter}
 */
export default class API extends EventEmitter {
  private db: Database
  private app: Express
  private router: Router
  private server: Server
  private authCache: AuthCache
  private state: RuntimeState
  private temporalClient!: TemporalClient
  private temporalWorker!: TemporalWorker
  /**
   * Initializes Express router with endpoints for profiles, posts, stats, and wallet operations
   * Sets up parameter handlers and configures routes for both GET and POST requests
   * @param state Runtime state for managing indexer state
   * @param db Database instance for handling data operations
   * @extends {EventEmitter} Inherits event handling capabilities
   */
  constructor(state: RuntimeState, db: Database) {
    super()
    this.state = state
    this.db = db
    this.authCache = new Map()
    //this.app = express()
    this.router = Router({
      caseSensitive: false,
      mergeParams: true,
      strict: true,
    })
    // Router parameter configuration
    this.router.param('platform', this.param.platform)
    this.router.param('profileId', this.param.profileId)
    this.router.param('postId', this.param.postId)
    this.router.param('statsRoute', this.param.statsRoute)
    this.router.param('pageNum', this.param.pageNum)
    this.router.param('scriptPayload', this.param.scriptPayload)
    this.router.param('instanceId', this.param.instanceId)
    // Router GET endpoint configuration (DEEPEST ROUTES FIRST!)
    this.router.get(
      '/wallet/summary/:scriptPayload/:startTime?/:endTime?',
      this.get.wallet,
    )
    this.router.get(
      '/wallet/:scriptPayload/:startTime?/:endTime?',
      this.get.wallet,
    )
    this.router.get(
      '/stats/:statsRoute(profiles/[a-z-]+|posts/[a-z-]+)/:timespan?/:votes?/:pageNum?',
      this.get.stats,
    )
    this.router.get(
      '/:platform/:profileId/:postId/:scriptPayload',
      this.get.post,
    )
    this.router.get('/:platform/:profileId/:postId', this.get.post)
    this.router.get('/:platform/:profileId', this.get.profile)
    // Router POST endpoint configuration (DEEPEST ROUTES FIRST!)
    // TODO: implement referral codes rather than mining instanceId
    //this.router.post('/instance/register', this.post.instance)
    // App/Server setup
    this.app = express()
    this.app.use(json())
    this.app.use('/api/v1', this.router)
    // App settings
    this.app.set('platformParams', PLATFORMS)
  }
  /**
   * Initialze database HTTP server and Temporal client/worker
   */
  async init() {
    this.server = this.app.listen(API_SERVER_PORT)
    log([
      ['init', 'api'],
      ['status', 'connected'],
      ['httpServer', 'listening'],
      ['httpServerPort', `${API_SERVER_PORT}`],
    ])
    // set up Temporal client and worker if complete configuration exists
    if (
      !Object.values(config.temporal).some(v => v === undefined || v === '')
    ) {
      try {
        // Temporal client
        this.temporalClient = new TemporalClient({
          connection: await Connection.connect({
            address: config.temporal.host,
          }),
          namespace: config.temporal.namespace,
        })
        // Temporal worker
        const activities = {
          ...this.temporalActivities,
          ...this.temporalLocalActivities,
        }
        this.temporalWorker = await TemporalWorker.create({
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
        this.temporalWorker.run()
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
   * POST parameter validator functions
   */
  private validate = {
    /**
     *
     * @param instanceId
     * @returns
     */
    instanceId: (instanceId: string | undefined) => {
      if (instanceId === undefined) {
        return {
          error: 'instanceId must be specified',
          statusCode: HTTP.BAD_REQUEST,
        }
      }
      if (!instanceId.match(/^[a-f0-9]{64}$/)) {
        return {
          error: 'instanceId is invalid format',
          statusCode: HTTP.BAD_REQUEST,
        }
      }
      return { instanceId }
    },
    /**
     *
     * @param scriptPayload
     * @returns
     */
    scriptPayload: (scriptPayload: string | undefined) => {
      if (scriptPayload === undefined) {
        return {
          error: 'scriptPayload must be specified',
          statusCode: HTTP.BAD_REQUEST,
        }
      }
      return Buffer.from(scriptPayload, 'hex').byteLength === 20
        ? { scriptPayload }
        : {
            error: 'scriptPayload is invalid',
            statusCode: HTTP.BAD_REQUEST,
          }
    },
    /**
     * Validates a message signature
     * @param scriptPayload - PKH used to generate `Address` for signature validation
     * @param data - The data payload to verify against the signature
     * @param signature - The signature of the data payload
     * @returns The validated signature
     */
    signature: ({
      scriptPayload,
      data,
      signature,
    }: {
      scriptPayload: string | undefined
      data: string | undefined
      signature: string | undefined
    }) => {
      if (scriptPayload === undefined) {
        return {
          error: 'scriptPayload must be specified',
          statusCode: HTTP.BAD_REQUEST,
        }
      }
      if (signature === undefined) {
        return {
          error: 'signature must be specified',
          statusCode: HTTP.BAD_REQUEST,
        }
      }
      if (data === undefined) {
        return {
          error: 'data must be specified',
          statusCode: HTTP.BAD_REQUEST,
        }
      }
      // convert scriptPayload to Address
      const address = Address.fromPublicKeyHash(
        Buffer.from(scriptPayload, 'hex'),
        Networks.livenet,
      )
      // verify message signature
      const message = new Message(data)
      if (!message.verify(address, signature)) {
        return {
          error: 'message signature is invalid',
          statusCode: HTTP.BAD_REQUEST,
        }
      }
      return { signature }
    },
  }
  /**
   * Shutdown the API server and Temporal interfaces
   */
  async close() {
    this.server?.closeAllConnections()
    this.server?.close()
    await this.temporalClient?.connection?.close()
    this.temporalWorker?.shutdown()
  }
  /**
   * Parameter Handlers
   */
  private param: {
    [param in EndpointParameter]: EndpointParameterHandler
  } = {
    /**
     *
     * @param req
     * @param res
     * @param next
     * @param platform
     * @returns
     */
    platform: async (
      req: Request,
      res: Response,
      next: NextFunction,
      platform: ScriptChunkPlatformUTF8,
    ) => {
      platform = platform.toLowerCase() as ScriptChunkPlatformUTF8
      const platformParams = PLATFORMS[platform]
      if (!platformParams) {
        return this.sendJSON(
          res,
          { error: `invalid platform specified` },
          HTTP.BAD_REQUEST,
        )
      }
      req.params.platform = platform
      next()
    },
    /**
     *
     * @param req
     * @param res
     * @param next
     * @param profileId
     * @returns
     */
    profileId: async (
      req: Request,
      res: Response,
      next: NextFunction,
      profileId: string,
    ) => {
      profileId = profileId.toLowerCase()
      const platform = req.params.platform as ScriptChunkPlatformUTF8
      const platformParams = this.app.get('platformParams') as typeof PLATFORMS
      const { profileId: profileIdParams } = platformParams[platform]
      if (profileId.length > profileIdParams.len) {
        return this.sendJSON(
          res,
          { error: `profileId is invalid length` },
          HTTP.BAD_REQUEST,
        )
      }
      req.params.profileId = profileId
      next()
    },
    /**
     *
     * @param req
     * @param res
     * @param next
     * @param postId
     * @returns
     */
    postId: async (
      req: Request,
      res: Response,
      next: NextFunction,
      postId: string,
    ) => {
      postId = postId.toLowerCase()
      const platform = req.params.platform as ScriptChunkPlatformUTF8
      const platformParams = this.app.get('platformParams') as typeof PLATFORMS
      const { postId: postIdParams } = platformParams[platform]
      if (!postId.match(postIdParams.regex)) {
        return this.sendJSON(
          res,
          { error: `postId is invalid format` },
          HTTP.BAD_REQUEST,
        )
      }
      switch (postIdParams.type) {
        case 'BigInt': {
          const buffer = Buffer.from(BigInt(postId).toString(16), 'hex')
          if (buffer.length != postIdParams.len) {
            return this.sendJSON(
              res,
              { error: `postId is invalid length` },
              HTTP.BAD_REQUEST,
            )
          }
          break
        }
        case 'String': {
          break
        }
      }
      req.params.postId = postId
      next()
    },
    /**
     *
     * @param req
     * @param res
     * @param next
     * @param scriptPayload
     */
    scriptPayload: async (
      req: Request,
      res: Response,
      next: NextFunction,
      scriptPayload: string | undefined,
    ) => {
      const result = this.validate.scriptPayload(scriptPayload)
      req.params.scriptPayload = result?.scriptPayload
      next()
    },
    /**
     *
     * @param req
     * @param res
     * @param next
     * @param statsRoute
     * @returns
     */
    statsRoute: async (
      req: Request,
      res: Response,
      next: NextFunction,
      statsRoute: StatsRoute,
    ) => {
      statsRoute = statsRoute.toLowerCase() as StatsRoute
      // Must be a defined route
      if (!StatsRoutes[statsRoute]) {
        return this.sendJSON(
          res,
          { error: `invalid stats path specified` },
          HTTP.BAD_REQUEST,
        )
      }
      req.params.statsRoute = statsRoute
      next()
    },
    /**
     *
     * @param req
     * @param res
     * @param next
     * @param pageNum
     * @returns
     */
    pageNum: async (
      req: Request,
      res: Response,
      next: NextFunction,
      pageNum: string | undefined,
    ) => {
      if (isNaN(Number(pageNum))) {
        return this.sendJSON(
          res,
          { error: `invalid votes page number specified` },
          HTTP.BAD_REQUEST,
        )
      }
      req.params.pageNum = pageNum
      next()
    },
    /**
     *
     * @param req
     * @param res
     * @param next
     * @param instanceId
     */
    instanceId: async (
      req: Request,
      res: Response,
      next: NextFunction,
      instanceId: string | undefined,
    ) => {
      const result = this.validate.instanceId(instanceId)
      if (result.error) {
        return this.sendJSON(res, { ...result }, result.statusCode)
      }
      req.params.instanceId = instanceId
      next()
    },
  }
  /**
   * GET Method Handlers
   */
  private get: { [name in Endpoint]?: EndpointHandler } = {
    /**
     *
     * @param req
     * @param res
     * @returns
     */
    profile: async (req: Request, res: Response) => {
      const t0 = performance.now()
      try {
        const { platform, profileId } = req.params
        // ranking bigint converted to string before return
        const result = await this.db.apiGetPlatformProfile(
          platform as ScriptChunkPlatformUTF8,
          profileId,
        )
        const t1 = (performance.now() - t0).toFixed(3)
        log([
          ['api', 'get.profile'],
          ['platform', `${platform}`],
          ['profileId', `${profileId}`],
          ['elapsed', `${t1}ms`],
        ])
        return this.sendJSON(res, result, HTTP.OK)
      } catch (e) {
        // Assume not found but log error to console
        const t1 = (performance.now() - t0).toFixed(3)
        log([
          ['api', 'error'],
          ['action', 'get.profile'],
          ...this.toLogEntries(req.params),
          ['message', `"${String(e)}"`],
          ['elapsed', `${t1}ms`],
        ])
        return this.sendJSON(
          res,
          { error: 'profile not found', params: req.params },
          HTTP.NOT_FOUND,
        )
      }
    },
    /**
     *
     * @param req
     * @param res
     * @returns
     */
    post: async (req: Request, res: Response) => {
      const t0 = performance.now()
      try {
        const { platform, profileId, postId, scriptPayload } = req.params
        // ranking bigint converted to string before return
        const result = await this.db.apiGetPlatformProfilePost(
          platform as ScriptChunkPlatformUTF8,
          profileId,
          postId,
          scriptPayload,
        )
        const t1 = (performance.now() - t0).toFixed(3)
        log([
          ['api', 'get.post'],
          ...this.toLogEntries(req.params),
          ['elapsed', `${t1}ms`],
        ])
        return this.sendJSON(res, result, HTTP.OK)
      } catch (e) {
        // Assume not found but log error to console
        const t1 = (performance.now() - t0).toFixed(3)
        log([
          ['api', 'error'],
          ['action', 'get.post'],
          ...this.toLogEntries(req.params),
          ['message', `"${String(e)}"`],
          ['elapsed', `${t1}ms`],
        ])
        return this.sendJSON(
          res,
          { error: 'post not found', params: req.params },
          HTTP.NOT_FOUND,
        )
      }
    },
    /**
     *
     * @param req
     * @param res
     */
    stats: async (req: Request, res: Response) => {
      const t0 = performance.now()
      try {
        const platform = req.params.platform as ScriptChunkPlatformUTF8
        const statsRoute = req.params.statsRoute as StatsRoute
        const [dataType, rankingType] = statsRoute.split(/\/|-/) as [
          'profiles' | 'posts',
          'top' | 'lowest',
        ]
        const startTime = req.params.timespan as Timespan
        const includeVotes = Boolean(req.params.votes == 'includeVotes')
        const pageNum = Number(req.params.pageNum)
        const dbMethod: keyof typeof this.db = StatsRoutes[statsRoute]
        const result = await this.db[dbMethod]({
          startTime: startTime,
          dataType: dataType == 'profiles' ? 'profileId' : 'postId',
          rankingType,
          includeVotes,
          pageNum,
        })
        const t1 = (performance.now() - t0).toFixed(3)
        log([
          ['api', 'get.stats'],
          ...this.toLogEntries(req.params),
          ['elapsed', `${t1}ms`],
        ])
        return this.sendJSON(res, result, HTTP.OK)
      } catch (e) {
        const t1 = (performance.now() - t0).toFixed(3)
        log([
          ['api', 'error'],
          ['action', 'get.stats'],
          ...this.toLogEntries(req.params),
          ['message', `"${String(e)}"`],
          ['elapsed', `${t1}ms`],
        ])
        return this.sendJSON(
          res,
          { error: 'stats not found', params: req.params },
          HTTP.NOT_FOUND,
        )
      }
    },
    /**
     * Handles wallet activity requests by retrieving `scriptPayload` activity data
     * @param req Express Request object containing `scriptPayload` and optional `timespan` parameters
     * @param res Express Response object to send back wallet activity data
     */
    wallet: async (req: Request, res: Response) => {
      const t0 = performance.now()
      const entries = [
        ['api', 'get.wallet'],
        ['action', 'walletActivity'],
        [
          'src',
          (req.headers['x-forwarded-for'] as string) ??
            req.socket.remoteAddress,
        ],
        ...this.toLogEntries(req.params),
      ] as LogEntry[]
      // validate the scriptPayload GET parameter
      const { scriptPayload, error } = this.validate.scriptPayload(
        req.params.scriptPayload,
      )
      if (error) {
        const t1 = (performance.now() - t0).toFixed(3)
        entries.push(['elapsed', `${t1}ms`])
        log(entries)
        return this.sendJSON(res, { error }, HTTP.BAD_REQUEST)
      }
      // parse and validate the `Authorization` header
      const [authData, authDataStr, signature] =
        this.processAuthorizationHeader(req.headers['authorization'])
      // check if the instanceId is already authorized
      // If not authorized, handle the authentication challenge
      if (!this.isRequestAuthorized(authData?.instanceId, authDataStr)) {
        if (
          !this.handleAuthChallenge({
            authData,
            authDataStr,
            signature,
            scriptPayload,
          })
        ) {
          const t1 = (performance.now() - t0).toFixed(3)
          entries.push(['elapsed', `${t1}ms`])
          log(entries)
          return this.sendAuthChallenge(res, this.state.checkpoint)
        }
        // client is now authorized
        this.authCache.set(authData.instanceId, {
          authDataStr,
          expiresAt: this.state.checkpoint.height + API_AUTH_CACHE_ENTRY_TTL,
        })
      }
      const startTime = (req.params.startTime ?? 'today') as Timespan
      const endTime = (req.params.endTime ?? 'now') as Timespan
      try {
        const isSummaryRequest = req.path.startsWith('/wallet/summary')
        const data = isSummaryRequest
          ? await this.db.ipcGetScriptPayloadActivitySummary({
              scriptPayload,
              startTime,
              endTime,
            })
          : (
              await this.db.ipcGetScriptPayloadActivity({
                scriptPayload,
                startTime,
                endTime,
              })
            ).map(item => ({
              ...item,
              timestamp: item.timestamp.toString(),
              sats: item.sats.toString(),
            }))
        const t1 = (performance.now() - t0).toFixed(3)
        entries.push(['elapsed', `${t1}ms`])
        log(entries)
        return this.sendJSON(res, data, HTTP.OK)
      } catch (e) {
        const t1 = (performance.now() - t0).toFixed(3)
        log([
          ['api', 'error'],
          ['action', 'get.wallet'],
          ['message', `"${String(e)}"`],
          ['elapsed', `${t1}ms`],
        ])
        return this.sendJSON(res, { error: e.message }, HTTP.BAD_REQUEST)
      }
    },
  }
  /**
   * POST Method Handlers
   */
  private post: { [name in Endpoint]?: EndpointHandler } = {
    /**
     *
     * @param req
     * @param res
     */
    instance: async (req: Request, res: Response) => {
      const t0 = performance.now()
      try {
        const body = req.body as {
          instanceId: string
          createdAt: string
          runtimeId: string
          startTime: string
          nonce: number
          scriptPayload: string
          signature: string
        }
        // validate the request body (i.e. POST data)
        let validated: {
          scriptPayload?: string
          instanceId?: string
          error?: string
          statusCode?: number
        }
        validated = this.validate.instanceId(body.instanceId)
        if (!validated.instanceId) {
          throw new Error(validated.error)
        }
        validated = this.validate.scriptPayload(body.scriptPayload)
        if (!validated.scriptPayload) {
          throw new Error('scriptPayload must be specified')
        }
        if (!Date.parse(body.createdAt)) {
          throw new Error(`createdAt date format is invalid`)
        }
        // validate instanceId matches input and meets/exceeds difficulty
        if (!(await isValidInstanceId(body))) {
          throw new Error(`instanceId does not match input data`)
        }
        // verify message signature
        if (
          !new Message(body.instanceId).verify(
            Address.fromPublicKeyHash(
              Buffer.from(body.scriptPayload, 'hex'),
              Networks.livenet,
            ),
            body.signature,
          )
        ) {
          throw new Error('message signature is invalid')
        }
        // register this instance in the database
        const registrationResult = await this.db.registerExtension({
          id: body.instanceId,
          scriptPayload: body.scriptPayload,
          createdAt: new Date(body.createdAt),
          lastSeen: new Date(),
        })
        if (registrationResult.error) {
          throw new Error(registrationResult.error)
        }
        // TODO: trigger Temporal workflow to fund the new instance
        await this.temporalClient.workflow.signalWithStart(
          config.temporal.command.workflowType,
          {
            signal: config.temporal.command.signal,
            taskQueue: config.temporal.taskQueue,
            workflowId: config.temporal.command.workflowId,
            signalArgs: [{ data: body }],
          },
        )
        // return registration result to clients
        const t1 = (performance.now() - t0).toFixed(3)
        log([
          ['api', 'post.instance'],
          ...this.toLogEntries(req.params),
          ['elapsed', `${t1}ms`],
        ])
        return this.sendJSON(res, req.body, HTTP.OK)
      } catch (e) {
        const t1 = (performance.now() - t0).toFixed(3)
        log([
          ['api', 'error'],
          ['action', 'post.instance'],
          ...this.toLogEntries(req.body),
          ['message', `"${String(e)}"`],
          ['elapsed', `${t1}ms`],
        ])
        return this.sendJSON(
          res,
          { error: e.message, params: req.body },
          HTTP.BAD_REQUEST,
        )
      }
    },
  }
  /**
   * Temporal Activity definitions (must be arrow functions)
   */
  temporalActivities = {
    /**
     * List all workflows matching the query and return the workflow execution info
     * @param query - The SQL-like query to list workflows
     * @returns The list of workflow executions
     */
    listWorkflows: async ({ query }: { query: string }) => {
      const workflowList = this.temporalClient.workflow.list({ query })
      const workflows: WorkflowExecutionInfo[] = []
      for await (const workflowInfo of workflowList) {
        workflows.push(workflowInfo)
      }
      return workflows
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
      return await this.temporalClient.workflow.result(workflowId, runId, {
        followRuns: false,
      })
    },
    /**
     * Execute a Temporal workflow, waiting for completion
     * @param param0 - Workflow type, workflowId, and args
     * @returns Workflow result
     */
    executeWorkflow: async ({
      workflowType,
      workflowId,
      args,
    }: {
      workflowType: string
      workflowId: string
      args?: unknown[]
    }) => {
      return await this.temporalClient.workflow.execute(workflowType, {
        taskQueue: config.temporal.taskQueue,
        workflowId,
        args,
      })
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
      return await this.temporalClient.workflow.start(workflowType, {
        taskQueue,
        workflowId,
        searchAttributes,
        args,
      })
    },
    /**
     *
     * @param param0
     * @returns
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
      return await this.temporalClient.workflow.signalWithStart(workflowType, {
        taskQueue,
        workflowId,
        args,
        signal,
        signalArgs,
      })
    },
    /**
     *
     * @param startTime
     * @param scriptPayload
     * @returns
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
        Buffer.from(scriptPayload, 'hex'),
        Networks.mainnet,
      )
      const activity = await this.db.ipcGetScriptPayloadActivity({
        startTime,
        endTime,
        scriptPayload,
      })
      return {
        address: address.toXAddress(),
        activity: activity.map(item => ({
          ...item,
          timestamp: item.timestamp.toString(),
          sats: item.sats.toString(),
        })),
      }
    },
    /**
     *
     * @param startTime
     * @param endTime
     * @returns
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
     *
     * @param platform
     * @returns
     */
    getAllTimeTopRankedProfiles: async (): Promise<RankTopProfile[]> => {
      return await this.db.getStatsPlatformRanked({
        dataType: 'profileId',
        rankingType: 'top',
        startTime: 'all',
      })
    },
    /**
     *
     * @param startTime
     * @returns
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
     *
     * @param startTime
     * @returns
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
  temporalLocalActivities = {}
  /**
   * Processes an authorization header string to extract authorization data, data string and signature
   * @param {string} header - The authorization header string to process, expected in base64 format
   * @returns {[AuthorizationData | null, string | null, string | null]} Tuple containing:
   *   - AuthorizationData object or null if invalid
   *   - Raw authorization data string or null if invalid
   *   - Signature string or null if invalid
   */
  private processAuthorizationHeader(
    header: string | undefined,
  ): [AuthorizationData, string, string] {
    if (header === undefined) {
      return [null, null, null]
    }
    const [authDataStr, signature] = Util.base64.decode(header).split(':::')
    if (!authDataStr || !signature) {
      return [null, null, null]
    }
    const authData = JSON.parse(authDataStr ?? '{}') as AuthorizationData
    return [authData, authDataStr, signature]
  }
  /**
   * Validates the authorization using blockchain data and signature.
   * The validation combines the blockhash and blockheight as a message and verifies
   * that the signature was created using the private key of the `scriptPayload`.
   * @param {Object} payload - The authorization data object
   * @param {string} payload.scriptPayload - The script payload to validate against
   * @param {string} payload.data - The JSON-encoded payload to validate
   * @param {string} payload.signature - The cryptographic signature created by signing the data with the private key
   * @returns {boolean} True if the signature is valid for the given scriptPayload and block data, false otherwise
   */
  private authBlockDataSig(payload: {
    scriptPayload: string
    data: string
    signature: string
  }) {
    return !!this.validate.signature(payload).signature
  }
  /**
   * Validates the authorization of an instanceId
   * @param instanceId - The instanceId to validate
   * @param authDataStr - The authDataStr to validate
   * @returns true if the instanceId is authorized, false otherwise
   */
  private isRequestAuthorized(
    instanceId: string | undefined,
    authDataStr: string | undefined,
  ) {
    // make sure the instanceId is provided
    if (instanceId === undefined) {
      return false
    }
    if (this.authCache.has(instanceId)) {
      if (!this.isValidAuthCacheEntry(instanceId, authDataStr)) {
        this.authCache.delete(instanceId)
      }
    }
    if (!this.authCache.has(instanceId)) {
      // returning false will trigger check for `Authorization: BlockDataSig` header
      return false
    }
    // return authorized
    return true
  }
  /**
   * Validates the authorization cache entry for the given instanceId and authDataStr
   * @param instanceId - The instanceId to validate
   * @param authDataStr - The authDataStr to validate
   * @returns true if the authorization cache entry is valid, false otherwise
   */
  private isValidAuthCacheEntry(instanceId: string, authDataStr: string) {
    // verify the authDataStr from the request matches the cached entry
    const authCacheEntry = this.authCache.get(instanceId)
    if (authDataStr && authCacheEntry.authDataStr !== authDataStr) {
      return false
    }
    // if latest indexed block height exceeds the auth cache entry
    // expiration, delete it
    else if (authCacheEntry.expiresAt < this.state.checkpoint.height) {
      return false
    }
    return true
  }
  /**
   * Handles authentication challenge validation for wallet-specific API requests
   * Verifies the provided authentication data against the current blockchain checkpoint
   * and authorizes the instance if validation is successful
   * @returns true if the authentication is valid, false otherwise
   */
  private handleAuthChallenge({
    authData,
    authDataStr,
    signature,
    scriptPayload,
  }: {
    authData: AuthorizationData
    authDataStr: string
    signature: string
    scriptPayload: string
  }) {
    if (!authData?.blockhash || !authData?.blockheight || !signature) {
      return false
    }
    // validate provided blockhash and blockheight against checkpoint
    if (
      authData.blockhash !== this.state.checkpoint.hash ||
      authData.blockheight !== this.state.checkpoint.height.toString()
    ) {
      return false
    }
    // Make sure the scriptPayload authData matches the GET parameter
    if (authData?.scriptPayload !== scriptPayload) {
      return false
    }
    // validate the signature using the scriptPayload in the request path
    const payload = { scriptPayload, data: authDataStr, signature }
    if (!this.authBlockDataSig(payload)) {
      return false
    }
    return true
  }
  /**
   * Sends an HTTP "401 Unauthorized" response with a `WWW-Authenticate` header
   * @param res Express Response object to send the response
   * @param checkpoint The latest indexed block to use for the challenge
   */
  private sendAuthChallenge(res: Response, checkpoint: Block) {
    const { hash, height } = checkpoint
    res
      .contentType('text/plain')
      .status(HTTP.UNAUTHORIZED)
      .header(
        'WWW-Authenticate',
        `BlockDataSig blockhash=${hash} blockheight=${height}`,
      )
      .send(`${HTTP.UNAUTHORIZED} Unauthorized`)
  }
  /**
   * Sends a JSON response with the specified data and status code
   * @param res Express Response object to send the JSON response
   * @param data Object containing the data to be sent as JSON
   * @param statusCode Optional HTTP status code (defaults to HTTP.OK if not provided)
   */
  private sendJSON(res: Response, data: object, statusCode?: number) {
    res
      .contentType('application/json')
      .status(statusCode ?? HTTP.OK)
      .json(data)
  }
  /**
   *
   * @param data
   * @returns
   */
  private toLogEntries(data: Request['params']): [string, string][] {
    return Object.entries(data).map(([k, v]) => [k, String(v)])
  }
}
