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
  type WorkflowExecutionInfo,
  type SearchAttributes,
  type SignalDefinition,
} from '@temporalio/client'
import { Worker as TemporalWorker, NativeConnection } from '@temporalio/worker'
import { Address, Message, Networks } from 'bitcore-lib-xpi'
import {
  PlatformConfiguration,
  type ScriptChunkPlatformUTF8,
  type InstanceData,
  Util,
  Block,
  toProfileIdBuf,
} from 'lotus-lib'
import RuntimeState from './state'
import Database, { getTimestampUTC, type Timespan } from './database'
import config from '../config'
import {
  API_AUTH_CACHE_ENTRY_TTL,
  API_SERVER_PORT,
  ERR,
  HTTP,
} from '../util/constants'
import { isValidInstanceId, log, type LogEntry } from '../util/functions'

/**
 * Represents a profile's ranking information including total and change metrics
 */
export type RankTopProfile = {
  /** Overall ranking statistics */
  total: {
    /** The total ranking score */
    ranking: string
    /** Total number of positive votes received */
    votesPositive: number
    /** Total number of negative votes received */
    votesNegative: number
  }
  /** Metrics showing ranking changes */
  changed: {
    /** The change in ranking score */
    ranking: string
    /** The rate of change */
    rate: string
    /** Number of new positive votes */
    votesPositive: number
    /** Number of new negative votes */
    votesNegative: number
  }
  /** Array of timestamps for vote history */
  votesTimespan: string[]
  /** Unique identifier for the profile */
  profileId: string
  /** The social media platform */
  platform: ScriptChunkPlatformUTF8
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
 * Represents the payload sent by an extension to authenticate with the API.
 */
type AuthorizationData = {
  /** Unique identifier for the extension instance. */
  instanceId: string
  /** The script payload used for authentication. */
  scriptPayload: string
  /** The block hash used for authentication. */
  blockhash: string
  /** The block height used for authentication. */
  blockheight: string
}
/**
 * Represents an entry in the authentication cache for an extension instance
 * @property {string} authDataStr - Stringified `AuthorizationData` object
 * @property {number} expiresAt - Block height at which the instance authorization will expire
 */
export type AuthCacheEntry = {
  /** The script payload used for authentication. */
  scriptPayload: string
  /** Stringified `AuthorizationData` object */
  authDataStr: string
  /** Block height at which the instance authorization will expire */
  expiresAt: number
}
/** Runtime cache of authenticated instances, where string is the `instanceId` */
export type AuthCache = Map<string, AuthCacheEntry>
export type Endpoint =
  | 'profiles'
  | 'profile'
  | 'post'
  | 'posts'
  | 'profilePosts'
  | 'stats'
  | 'instance'
  | 'wallet'
  | 'charts'
  | 'search'
  | 'tx'
  | 'txs'
  | 'voteActivity'
export type EndpointHandler = (req: Request, res: Response) => void
export type EndpointParameter =
  | 'platform'
  | 'profileId'
  | 'postId'
  | 'scriptPayload'
  | 'statsRoute'
  | 'pageNum'
  | 'pageSize'
  | 'instanceId'
  | 'chartType'
  | 'dataType'
  | 'searchType'
  | 'txid'
/** This type is data returned from the database, not Temporal */
export type ChartWalletSummary = {
  /** Total number of votes cast */
  totalVotes: number
  /** Total number of upvotes cast */
  totalUpvotes: number
  /** Total number of downvotes cast */
  totalDownvotes: number
  /** Total number of unique wallets that voted */
  totalUniqueWallets: number
  /** Total amount of Lotus burned in all of the votes */
  totalSatsBurned: number
}
/** This type is data returned from the Temporal workflow */
export type WalletRankActivityWorkflowResult = {
  /** Total number of votes cast */
  totalVotes: number
  /** Total number of payouts sent */
  totalPayoutsSent: number
  /** Total amount of sats sent */
  totalPayoutAmount: number
}
export type ChartType = 'wallet'
export type ChartDataType = 'summary' | 'activity'
export type SearchType = 'profile' | 'post'
export type EndpointParameterHandler = (
  req: Request,
  res: Response,
  next: NextFunction,
  param: string | undefined,
) => void

export enum StatsRoutes {
  'profiles/top-ranked' = 'getStatsPlatformRanked',
  'profiles/lowest-ranked' = 'getStatsPlatformRanked',
  'posts/top-ranked' = 'getStatsPlatformRanked',
  'posts/lowest-ranked' = 'getStatsPlatformRanked',
}
export type StatsRoute = keyof typeof StatsRoutes

/** Authentication header parameters provided to client for authorization to API */
export const AuthenticateHeader = {
  /** The scheme of the authentication header */
  scheme: 'BlockDataSig' as const,
  /** The parameters of the authentication header */
  param: ['blockhash', 'blockheight'] as const,
}

/**
 * Validates that the provided parameters are valid and sets the request parameters
 * @param req Express Request object containing `platform` and `scriptPayload` parameters
 * @param res Express Response object for sending HTTP responses
 * @param next Express NextFunction for calling the next middleware function
 * @param param The parameter to validate
 */
const Parameters: Record<EndpointParameter, EndpointParameterHandler> = {
  /**
   * Validates that the provided `platform` is a valid platform.
   * If invalid, responds with HTTP 400 and an error message.
   */
  platform: async (
    req: Request,
    res: Response,
    next: NextFunction,
    platform: ScriptChunkPlatformUTF8,
  ) => {
    platform = platform.toLowerCase() as ScriptChunkPlatformUTF8
    const platformParams = PlatformConfiguration.get(platform)
    if (!platformParams) {
      return sendJSON(
        res,
        { error: `invalid platform specified` },
        HTTP.BAD_REQUEST,
      )
    }
    req.params.platform = platform
    next()
  },
  /**
   * Validates that the provided `profileId` is a valid profile ID for the specified platform.
   * If invalid, responds with HTTP 400 and an error message.
   */
  profileId: async (
    req: Request,
    res: Response,
    next: NextFunction,
    profileId: string,
  ) => {
    profileId = profileId.toLowerCase()
    const platform = req.params.platform as ScriptChunkPlatformUTF8
    // toProfileIdBuf will return null if the profileId is invalid
    if (toProfileIdBuf(platform, profileId) === null) {
      return sendJSON(
        res,
        { error: `invalid profileId specified` },
        HTTP.BAD_REQUEST,
      )
    }
    req.params.profileId = profileId
    next()
  },
  /**
   * Validates that the provided `postId` is a valid post ID for the specified platform.
   * If invalid, responds with HTTP 400 and an error message.
   */
  postId: async (
    req: Request,
    res: Response,
    next: NextFunction,
    postId: string,
  ) => {
    postId = postId.toLowerCase()
    const platform = req.params.platform as ScriptChunkPlatformUTF8
    const { postId: postIdParams } = PlatformConfiguration.get(platform)
    if (!postId.match(postIdParams.regex)) {
      return sendJSON(
        res,
        { error: `postId is invalid format` },
        HTTP.BAD_REQUEST,
      )
    }
    switch (postIdParams.type) {
      case 'BigInt': {
        const buffer = Buffer.from(BigInt(postId).toString(16), 'hex')
        if (buffer.length != postIdParams.len) {
          return sendJSON(
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
   * Validates that the provided `chartType` is a valid chart type.
   * If invalid, responds with HTTP 400 and an error message.
   */
  chartType: async (
    req: Request,
    res: Response,
    next: NextFunction,
    chartType: ChartType,
  ) => {
    switch (chartType) {
      case 'wallet':
        break
      default:
        return sendJSON(
          res,
          { error: `invalid chart type specified` },
          HTTP.BAD_REQUEST,
        )
    }
    req.params.chartType = chartType
    next()
  },
  /**
   * Validates that the provided `dataType` is a valid chart data type.
   * If invalid, responds with HTTP 400 and an error message.
   */
  dataType: async (
    req: Request,
    res: Response,
    next: NextFunction,
    dataType: ChartDataType,
  ) => {
    switch (dataType) {
      case 'activity':
        break
      case 'summary':
        break
      default:
        return sendJSON(
          res,
          { error: `invalid chart data type specified` },
          HTTP.BAD_REQUEST,
        )
    }
    req.params.dataType = dataType
    next()
  },
  /**
   * Validates that the provided `searchType` is a valid search type.
   * If invalid, responds with HTTP 400 and an error message.
   */
  searchType: async (
    req: Request,
    res: Response,
    next: NextFunction,
    searchType: SearchType,
  ) => {
    const validated = validate.searchType(searchType)
    if (validated.error) {
      return sendJSON(res, { error: validated.error }, validated.statusCode)
    }
    req.params.searchType = validated.searchType
    next()
  },
  /**
   * Validates that the provided `scriptPayload` is a valid script payload.
   * If invalid, responds with HTTP 400 and an error message.
   */
  scriptPayload: async (
    req: Request,
    res: Response,
    next: NextFunction,
    scriptPayload: string | undefined,
  ) => {
    const result = validate.scriptPayload(scriptPayload)
    // TODO: handle signature validation here
    req.params.scriptPayload = result?.scriptPayload
    next()
  },
  /**
   * Validates that the provided `statsRoute` is a valid stats route.
   * If invalid, responds with HTTP 400 and an error message.
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
      return sendJSON(
        res,
        { error: `invalid stats path specified` },
        HTTP.BAD_REQUEST,
      )
    }
    req.params.statsRoute = statsRoute
    next()
  },
  /**
   * Validates that the provided `pageNum` is a positive integer.
   * If invalid, responds with HTTP 400 and an error message.
   */
  pageNum: async (
    req: Request,
    res: Response,
    next: NextFunction,
    pageNum: string | undefined,
  ) => {
    if (isNaN(Number(pageNum))) {
      return sendJSON(
        res,
        { error: `invalid votes page number specified` },
        HTTP.BAD_REQUEST,
      )
    }
    req.params.pageNum = pageNum
    next()
  },
  /**
   * Validates that the provided `pageSize` is a positive integer.
   * If invalid, responds with HTTP 400 and an error message.
   */
  pageSize: async (
    req: Request,
    res: Response,
    next: NextFunction,
    pageSize: string | undefined,
  ) => {
    const pageSizeNum = Number(pageSize)
    if (isNaN(pageSizeNum) || pageSizeNum < 1) {
      return sendJSON(
        res,
        { error: `invalid page size specified` },
        HTTP.BAD_REQUEST,
      )
    }
    // enforce max page size
    if (pageSizeNum > 40) {
      pageSize = '40'
    }
    req.params.pageSize = pageSize
    next()
  },
  /**
   * Validates that the provided `instanceId` is a 64-character hexadecimal string.
   * If invalid, responds with HTTP 400 and an error message.
   */
  instanceId: async (
    req: Request,
    res: Response,
    next: NextFunction,
    instanceId: string | undefined,
  ) => {
    const result = validate.instanceId(instanceId)
    if (result.error) {
      return sendJSON(res, { ...result }, result.statusCode)
    }
    req.params.instanceId = instanceId
    next()
  },
  /**
   * Validates that the provided `txid` is a 64-character hexadecimal string.
   * If invalid, responds with HTTP 400 and an error message.
   */
  txid: async (
    req: Request,
    res: Response,
    next: NextFunction,
    txid: string | undefined,
  ) => {
    if (!txid.match(/^[0-9a-fA-F]{64}$/)) {
      return sendJSON(
        res,
        { error: `invalid txid specified` },
        HTTP.BAD_REQUEST,
      )
    }
    req.params.txid = txid
    next()
  },
}

/**
 * Validator functions for API parameters
 */
const validate = {
  /**
   * Validates that the provided `instanceId` is a 64-character hexadecimal string.
   * If invalid, responds with HTTP 400 and an error message.
   * @param instanceId - The instance ID to validate
   * @returns The validated instance ID
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
   * Validates that the provided `scriptPayload` is a valid script payload.
   * If invalid, responds with HTTP 400 and an error message.
   * @param scriptPayload - The script payload to validate
   * @returns The validated script payload
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
   * @param signature - The signature of the data payload to validate
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
  /**
   * Validates a search type
   * @param searchType - The search type to validate
   * @returns The validated search type
   */
  searchType: (searchType: SearchType | undefined) => {
    if (searchType === undefined) {
      return {
        error: 'search type must be specified',
        statusCode: HTTP.BAD_REQUEST,
      }
    }
    if (!['profile', 'post'].includes(searchType)) {
      return {
        error: 'invalid search type specified',
        statusCode: HTTP.BAD_REQUEST,
      }
    }
    return { searchType }
  },
}

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
    this.router.param('platform', Parameters.platform)
    this.router.param('profileId', Parameters.profileId)
    this.router.param('postId', Parameters.postId)
    this.router.param('statsRoute', Parameters.statsRoute)
    this.router.param('pageNum', Parameters.pageNum)
    this.router.param('scriptPayload', Parameters.scriptPayload)
    this.router.param('instanceId', Parameters.instanceId)
    this.router.param('chartType', Parameters.chartType)
    this.router.param('dataType', Parameters.dataType)
    this.router.param('searchType', Parameters.searchType)
    this.router.param('txid', Parameters.txid)
    // Router GET endpoint configuration (DEEPEST ROUTES FIRST!)
    this.router.get(
      '/wallet/summary/:scriptPayload/:startTime?/:endTime?',
      this.GET.wallet,
    )
    this.router.get(
      '/wallet/:scriptPayload/:startTime?/:endTime?',
      this.GET.wallet,
    )
    this.router.get('/votes/:page?/:pageSize?', this.GET.voteActivity)
    this.router.get('/txs/:platform/:profileId/:page?/:pageSize?', this.GET.txs)
    this.router.get('/charts/:chartType/:dataType/:timespan?', this.GET.charts)
    this.router.get('/profiles/:page?/:pageSize?', this.GET.profiles)
    this.router.get('/search/:searchType/:query', this.GET.search)
    this.router.get(
      '/stats/:statsRoute(profiles/[a-z-]+|posts/[a-z-]+)/:timespan?/:votes?/:pageNum?',
      this.GET.stats,
    )
    this.router.get(
      '/:platform/:profileId/:postId/:scriptPayload',
      this.GET.post,
    )
    this.router.get(
      '/:platform/:profileId/posts/:page?/:pageSize?',
      this.GET.profilePosts,
    )
    this.router.get('/:platform/:profileId/:postId', this.GET.post)
    this.router.get('/:platform/:profileId', this.GET.profile)
    // Router POST endpoint configuration (DEEPEST ROUTES FIRST!)
    // TODO: implement referral codes rather than mining instanceId
    //this.router.post('/instance/register', this.POST.instance)
    // Get posts for a platform, up to 50 maximum per request
    this.router.post('/posts/:platform/:scriptPayload', this.POST.posts)
    // Router PATCH endpoint configuration (DEEPEST ROUTES FIRST!)
    //this.router.patch('/:platform/:profileId/:postId', this.PATCH.post)

    // App/Server setup
    this.app = express()
    this.app.use(json())
    this.app.use('/api/v1', this.router)
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
   * Shutdown the API server and Temporal interfaces
   */
  async close() {
    this.server?.closeAllConnections()
    this.server?.close()
    await this.temporalClient?.connection?.close()
    this.temporalWorker?.shutdown()
  }
  /**
   * GET Method Handlers
   */
  private GET: Partial<Record<Endpoint, EndpointHandler>> = {
    /**
     *
     * @param req
     * @param res
     * @returns
     */
    profiles: async (req: Request, res: Response) => {
      const t0 = performance.now()
      const page = Number(req.params.page)
      const pageSize = Number(req.params.pageSize)
      try {
        const result = await this.db.apiGetProfiles(page, pageSize)
        const t1 = (performance.now() - t0).toFixed(3)
        log([
          ['api', 'get.profiles'],
          ...toLogEntries(req.params),
          ['elapsed', `${t1}ms`],
        ])
        return sendJSON(res, result, HTTP.OK)
      } catch (e) {
        const t1 = (performance.now() - t0).toFixed(3)
        log([
          ['api', 'error'],
          ['action', 'get.profiles'],
          ...toLogEntries(req.params),
          ['message', `"${String(e)}"`],
          ['elapsed', `${t1}ms`],
        ])
        return sendJSON(
          res,
          { error: 'profiles not found', params: req.params },
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
        return sendJSON(res, result, HTTP.OK)
      } catch (e) {
        // Assume not found but log error to console
        const t1 = (performance.now() - t0).toFixed(3)
        log([
          ['api', 'error'],
          ['action', 'get.profile'],
          ...toLogEntries(req.params),
          ['message', `"${String(e)}"`],
          ['elapsed', `${t1}ms`],
        ])
        return sendJSON(
          res,
          { error: 'profile not found', params: req.params },
          HTTP.NOT_FOUND,
        )
      }
    },
    /**
     * Retrieves posts for a platform profile
     * @param req Express Request object containing `platform` and `profileId` parameters
     * @param res Express Response object to send back posts data
     * @returns JSON response with posts data or error message
     */
    profilePosts: async (req: Request, res: Response) => {
      const t0 = performance.now()
      const { platform, profileId } = req.params
      const page = Number(req.params.page)
      const pageSize = Number(req.params.pageSize)
      try {
        const result = await this.db.apiGetPlatformProfilePosts(
          platform as ScriptChunkPlatformUTF8,
          profileId,
          page,
          pageSize,
        )
        const t1 = (performance.now() - t0).toFixed(3)
        log([
          ['api', 'get.profilePosts'],
          ...toLogEntries(req.params),
          ['elapsed', `${t1}ms`],
        ])
        return sendJSON(res, result, HTTP.OK)
      } catch (e) {
        const t1 = (performance.now() - t0).toFixed(3)
        log([
          ['api', 'error'],
          ['action', 'get.profilePosts'],
          ...toLogEntries(req.params),
          ['message', `"${String(e)}"`],
          ['elapsed', `${t1}ms`],
        ])
        return sendJSON(
          res,
          { error: 'profile posts not found', params: req.params },
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
        log([
          ['api', 'get.post'],
          ...toLogEntries(req.params),
          ['elapsed', `${(performance.now() - t0).toFixed(3)}ms`],
        ])
        return sendJSON(res, result, HTTP.OK)
      } catch (e) {
        // Assume not found but log error to console
        log([
          ['api', 'error'],
          ['action', 'get.post'],
          ...toLogEntries(req.params),
          ['message', `"${String(e)}"`],
          ['elapsed', `${(performance.now() - t0).toFixed(3)}ms`],
        ])
        return sendJSON(
          res,
          { error: 'post not found', params: req.params },
          HTTP.NOT_FOUND,
        )
      }
    },
    /**
     * Charts API endpoint that provides different chart data based on chart type and timespan
     * @remarks
     * Supports wallet activity and wallet summary charts with different timespan options
     * @example
     * ```
     * GET /api/v1/charts/wallet/activity/week
     * GET /api/v1/charts/wallet/summary/month
     * ```
     * @param req - Express request object containing chart type and timespan parameters
     * @param res - Express response object to send back chart data
     * @returns JSON response with chart data or error message
     */
    charts: async (req: Request, res: Response) => {
      const t0 = performance.now()
      const chartType = req.params.chartType as ChartType
      const dataType = req.params.dataType as ChartDataType
      const startTime = (req.params.timespan ?? 'day') as Timespan

      switch (chartType) {
        case 'wallet': {
          let result: object
          if (dataType == 'activity') {
            const timespan =
              startTime.charAt(0).toUpperCase() + startTime.slice(1)
            result = (await this.temporalActivities.queryWorkflow({
              workflowId: config.temporal.api.chartsWalletActivity.workflowId,
              queryType:
                config.temporal.api.chartsWalletActivity.queryType + timespan,
            })) as WalletRankActivityWorkflowResult
          }
          if (dataType == 'summary') {
            result = (await this.db.apiChartWalletSummary(
              startTime,
            )) as ChartWalletSummary
          }
          const t1 = (performance.now() - t0).toFixed(3)
          log([
            ['api', 'get.charts'],
            ...toLogEntries(req.params),
            ['elapsed', `${t1}ms`],
          ])
          return sendJSON(res, result, HTTP.OK)
        }
        default:
          return sendJSON(
            res,
            { error: `invalid chart type specified` },
            HTTP.BAD_REQUEST,
          )
      }
    },
    /**
     *
     * @param req
     * @param res
     * @returns
     */
    search: async (req: Request, res: Response) => {
      const t0 = performance.now()
      const query = req.params.query ?? ''
      // if no query or query length is insufficient, return empty array
      if (!query || query.length < 2) {
        const t1 = (performance.now() - t0).toFixed(3)
        log([
          ['api', 'get.search'],
          ...toLogEntries(req.params),
          ['elapsed', `${t1}ms`],
        ])
        return sendJSON(res, [], HTTP.OK)
      }
      try {
        const result = await this.db.apiSearchProfile(query)
        const t1 = (performance.now() - t0).toFixed(3)
        log([
          ['api', 'get.search'],
          ...toLogEntries(req.params),
          ['elapsed', `${t1}ms`],
        ])
        return sendJSON(res, result, HTTP.OK)
      } catch (e) {
        const t1 = (performance.now() - t0).toFixed(3)
        log([
          ['api', 'error'],
          ['action', 'get.search'],
          ...toLogEntries(req.params),
          ['message', `"${String(e)}"`],
          ['elapsed', `${t1}ms`],
        ])
        return sendJSON(
          res,
          { error: 'search not found', params: req.params },
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
          ...toLogEntries(req.params),
          ['elapsed', `${t1}ms`],
        ])
        return sendJSON(res, result, HTTP.OK)
      } catch (e) {
        const t1 = (performance.now() - t0).toFixed(3)
        log([
          ['api', 'error'],
          ['action', 'get.stats'],
          ...toLogEntries(req.params),
          ['message', `"${String(e)}"`],
          ['elapsed', `${t1}ms`],
        ])
        return sendJSON(
          res,
          { error: 'stats not found', params: req.params },
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
    txs: async (req: Request, res: Response) => {
      const t0 = performance.now()
      const { platform, profileId } = req.params
      const page = Number(req.params.page)
      const pageSize = Number(req.params.pageSize)
      try {
        const result = await this.db.apiGetPlatformProfileVotesTableData(
          platform as ScriptChunkPlatformUTF8,
          profileId,
          page,
          pageSize,
        )
        const t1 = (performance.now() - t0).toFixed(3)
        log([
          ['api', 'get.txs'],
          ...toLogEntries(req.params),
          ['elapsed', `${t1}ms`],
        ])
        return sendJSON(res, result, HTTP.OK)
      } catch (e) {
        const t1 = (performance.now() - t0).toFixed(3)
        log([
          ['api', 'error'],
          ['action', 'get.txs'],
          ...toLogEntries(req.params),
          ['message', `"${String(e)}"`],
          ['elapsed', `${t1}ms`],
        ])
        return sendJSON(
          res,
          { error: 'txs not found', params: req.params },
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
        ...toLogEntries(req.params),
      ] as LogEntry[]
      // validate the scriptPayload GET parameter
      const { scriptPayload, error } = validate.scriptPayload(
        req.params.scriptPayload,
      )
      if (error) {
        const t1 = (performance.now() - t0).toFixed(3)
        entries.push(['elapsed', `${t1}ms`])
        log(entries)
        return sendJSON(res, { error }, HTTP.BAD_REQUEST)
      }
      // parse and validate the `Authorization` header
      const [authData, authDataStr, signature] =
        this.processAuthorizationHeader(req.headers['authorization'])
      // If the auth cache entry is no longer valid, delete it
      if (this.isAuthCacheEntryExpired(authData?.instanceId)) {
        this.authCache.delete(authData?.instanceId)
      }
      // check if the instanceId/scriptPayload combination is already authorized
      // If not authorized, handle the authentication challenge
      if (
        !this.isRequestAuthorized(
          scriptPayload,
          authData?.instanceId,
          authDataStr,
        )
      ) {
        // If the auth challenge fails, return a 401 Unauthorized response
        // with the challenge data
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
          return sendAuthChallenge(res, this.state.checkpoint)
        }
        // If the auth challenge succeeds, add the instanceId to the auth cache
        // with expiration based on the current block height
        this.authCache.set(authData.instanceId, {
          scriptPayload,
          authDataStr,
          expiresAt: this.state.checkpoint.height + API_AUTH_CACHE_ENTRY_TTL,
        })
      }
      const startTime = (req.params.startTime ?? 'today') as Timespan
      const endTime = (req.params.endTime ?? 'now') as Timespan
      try {
        const data = req.path.startsWith('/wallet/summary')
          ? await this.db.ipcGetScriptPayloadActivitySummary({
              scriptPayload,
              startTime,
              endTime,
            })
          : await this.db.ipcGetScriptPayloadActivity(
              {
                scriptPayload,
                startTime,
                endTime,
              },
              'api',
            )
        const t1 = (performance.now() - t0).toFixed(3)
        entries.push(['elapsed', `${t1}ms`])
        log(entries)
        return sendJSON(res, data, HTTP.OK)
      } catch (e) {
        const t1 = (performance.now() - t0).toFixed(3)
        log([
          ['api', 'error'],
          ['action', 'get.wallet'],
          ['message', `"${String(e)}"`],
          ['elapsed', `${t1}ms`],
        ])
        return sendJSON(res, { error: e.message }, HTTP.BAD_REQUEST)
      }
    },
    /**
     * Handles vote activity requests by retrieving vote activity data
     * @param req Express Request object containing `page` and `pageSize` parameters
     * @param res Express Response object to send back vote activity data
     */
    voteActivity: async (req: Request, res: Response) => {
      const t0 = performance.now()
      const page = Number(req.params.page)
      const pageSize = Number(req.params.pageSize)
      try {
        const result = await this.db.apiGetVoteActivity(page, pageSize)
        const t1 = (performance.now() - t0).toFixed(3)
        log([
          ['api', 'get.voteActivity'],
          ...toLogEntries(req.params),
          ['elapsed', `${t1}ms`],
        ])
        return sendJSON(res, result, HTTP.OK)
      } catch (e) {
        const t1 = (performance.now() - t0).toFixed(3)
        log([
          ['api', 'error'],
          ['action', 'get.voteActivity'],
          ...toLogEntries(req.params),
          ['message', `"${String(e)}"`],
          ['elapsed', `${t1}ms`],
        ])
        return sendJSON(
          res,
          { error: 'vote activity not found', params: req.params },
          HTTP.NOT_FOUND,
        )
      }
    },
  }
  /**
   * PATCH Method Handlers
   */
  private PATCH: { [name in Endpoint]?: EndpointHandler } = {
    post: async (req: Request, res: Response) => {
      const t0 = performance.now()
      const { platform, profileId, postId } = req.params
      const content = req.body.content as string
      try {
        /* const result = await this.db.apiUpsertPlatformProfilePost(
          platform as ScriptChunkPlatformUTF8,
          profileId,
          postId,
          content,
        )
        const t1 = (performance.now() - t0).toFixed(3)
        log([
          ['api', 'patch.post'],
          ...toLogEntries(req.params),
          ['elapsed', `${t1}ms`],
        ])
        return sendJSON(res, result, HTTP.OK) */
      } catch (e) {
        const t1 = (performance.now() - t0).toFixed(3)
        log([
          ['api', 'error'],
          ['action', 'patch.post'],
          ...toLogEntries(req.params),
          ['message', `"${String(e)}"`],
          ['elapsed', `${t1}ms`],
        ])
        return sendJSON(
          res,
          { error: 'post not found', params: req.params },
          HTTP.NOT_FOUND,
        )
      }
    },
  }
  /**
   * POST Method Handlers
   */
  private POST: Partial<Record<Endpoint, EndpointHandler>> = {
    /**
     * Retrieves posts for a platform
     * @param req Express Request object containing `platform` and `scriptPayload` parameters
     * @param res Express Response object to send back posts data
     */
    posts: async (req: Request, res: Response) => {
      const t0 = performance.now()
      if (req.headers['content-type'] !== 'application/json') {
        return sendJSON(
          res,
          { error: 'invalid content type' },
          HTTP.BAD_REQUEST,
        )
      }
      const { platform, scriptPayload } = req.params
      // if we don't have the scriptPayload, it was not validated
      if (!scriptPayload) {
        return sendJSON(
          res,
          { error: 'scriptPayload invalid or not specified' },
          HTTP.BAD_REQUEST,
        )
      }
      const body = Array.from(req.body) as Array<{
        profileId: string
        postId: string
      }>
      try {
        const result = await this.db.apiGetPlatformPosts(
          platform as ScriptChunkPlatformUTF8,
          scriptPayload,
          body,
        )
        const t1 = (performance.now() - t0).toFixed(3)
        log([
          ['api', 'post.posts'],
          ...toLogEntries(req.params),
          ['elapsed', `${t1}ms`],
        ])
        return sendJSON(res, result, HTTP.OK)
      } catch (e) {
        const t1 = (performance.now() - t0).toFixed(3)
        log([
          ['api', 'error'],
          ['action', 'post.posts'],
          ...toLogEntries(req.params),
          ['message', `"${String(e)}"`],
          ['elapsed', `${t1}ms`],
        ])
        return sendJSON(res, { error: e.message }, HTTP.BAD_REQUEST)
      }
    },
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
        validated = validate.instanceId(body.instanceId)
        if (!validated.instanceId) {
          throw new Error(validated.error)
        }
        validated = validate.scriptPayload(body.scriptPayload)
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
          ...toLogEntries(req.params),
          ['elapsed', `${t1}ms`],
        ])
        return sendJSON(res, req.body, HTTP.OK)
      } catch (e) {
        const t1 = (performance.now() - t0).toFixed(3)
        log([
          ['api', 'error'],
          ['action', 'post.instance'],
          ...toLogEntries(req.body),
          ['message', `"${String(e)}"`],
          ['elapsed', `${t1}ms`],
        ])
        return sendJSON(
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
      const queryResult = this.temporalClient.workflow.list({ query })
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
      return await this.temporalClient.workflow.result(workflowId, runId, {
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
      const handle = this.temporalClient.workflow.getHandle(workflowId)
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
      return await this.temporalClient.workflow.start(workflowType, {
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
      return await this.temporalClient.workflow.signalWithStart(workflowType, {
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
  temporalLocalActivities = {
    /**
     * Async wrapper for `getTimestampUTC`
     */
    getTimestampUTC: async (timespan: Timespan) => {
      return getTimestampUTC(timespan)
    },
  }
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
  }): boolean {
    return !!validate.signature(payload).signature
  }
  /**
   * Validates the authorization of an instanceId
   * @param scriptPayload - The GET parameter `scriptPayload`
   * @param instanceId - The instanceId to validate
   * @param authDataStr - The authDataStr to validate
   * @returns true if the instanceId is authorized, false otherwise
   */
  private isRequestAuthorized(
    scriptPayload: string,
    instanceId: string | undefined,
    authDataStr: string | undefined,
  ) {
    // make sure the instanceId is provided
    if (instanceId === undefined) {
      return false
    }
    if (!this.authCache.has(instanceId)) {
      // returning false will trigger check for `Authorization: BlockDataSig` header
      return false
    }
    // verify the authDataStr and scriptPayload from the request matches the cached entry
    const authCacheEntry = this.authCache.get(instanceId)
    if (
      authDataStr &&
      authCacheEntry.authDataStr !== authDataStr &&
      authCacheEntry.scriptPayload !== scriptPayload
    ) {
      return false
    }
    // return authorized
    return true
  }
  /**
   * Checks if the auth cache entry is expired
   * @param instanceId - The instanceId to check
   * @returns true if the auth cache entry is expired, false otherwise
   */
  private isAuthCacheEntryExpired(instanceId: string) {
    const authCacheEntry = this.authCache.get(instanceId)
    return authCacheEntry.expiresAt < this.state.checkpoint.height
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
}
/**
 * Converts a request parameter object to an array of key-value pairs for logging
 * @param data The request parameter object to convert
 * @returns An array of key-value pairs for logging
 */
function toLogEntries(data: Request['params']): [string, string][] {
  return Object.entries(data).map(([k, v]) => [k, String(v)])
}

/**
 * Sends a JSON response with the specified data and status code
 * @param res Express Response object to send the JSON response
 * @param data Object containing the data to be sent as JSON
 * @param statusCode Optional HTTP status code (defaults to HTTP.OK if not provided)
 */
function sendJSON(res: Response, data: object, statusCode?: number) {
  res
    .contentType('application/json')
    .status(statusCode ?? HTTP.OK)
    .json(data)
}

/**
 * Sends an HTTP "401 Unauthorized" response with a `WWW-Authenticate` header
 * @param res Express Response object to send the response
 * @param checkpoint The latest indexed block to use for the challenge
 */
function sendAuthChallenge(res: Response, checkpoint: Block) {
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
