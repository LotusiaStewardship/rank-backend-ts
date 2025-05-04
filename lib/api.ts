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
} from '@temporalio/client'
import { Worker as TemporalWorker, NativeConnection } from '@temporalio/worker'
import { Address, Message, Networks } from 'bitcore-lib-xpi'
import { PLATFORMS, log, type ScriptChunkPlatformUTF8 } from 'rank-lib'
import Database, { type Timespan } from './database'
import config from '../config'
import { API_SERVER_PORT, ERR, HTTP } from '../util/constants'
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
/** */
export type ScriptPayloadActivity = {
  scriptPayload: string
  voteCount: number
  /** Total number of sats burned during `Timespan` */
  sats: string
}
type Endpoint = 'profile' | 'post' | 'stats' | 'instance'
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
  private temporalClient!: TemporalClient
  private temporalWorker!: TemporalWorker
  /**
   *
   * @param db
   */
  constructor(db: Database) {
    super()
    this.db = db
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
          if (buffer.length != postIdParams.chunkLength) {
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
     *
     * @param param0
     * @returns
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
    getRankActivityByScriptPayload: async (
      startTime: Timespan | undefined,
      scriptPayload: string,
    ) => {
      const address = Address.fromPublicKeyHash(
        Buffer.from(scriptPayload, 'hex'),
        Networks.mainnet,
      )
      const activity = await this.db.ipcGetScriptPayloadActivity({
        startTime,
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
    getWalletRankActivity: async (startTime: Timespan, endTime?: Timespan) => {
      return (
        await this.db.ipcGetScriptPayloadActivitySummary({
          startTime,
          endTime,
        })
      ).map(
        ({ scriptPayload, voteCount, sats }) =>
          ({
            scriptPayload,
            voteCount,
            // convert sats BigInt to string for Temporal payload messaging
            sats: sats.toString(),
          }) as ScriptPayloadActivity,
      )
    },
    /**
     *
     * @param platform
     * @returns
     */
    getAllTimeTopRankedProfiles: async (
      platform: ScriptChunkPlatformUTF8,
    ): Promise<RankTopProfile[]> => {
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
   *
   * @param res
   * @param data
   * @param statusCode
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
