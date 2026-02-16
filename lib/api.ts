import { Server } from 'node:http'
import { EventEmitter } from 'node:events'
import { createHmac, randomBytes } from 'node:crypto'
import express, {
  Express,
  Router,
  Request,
  Response,
  NextFunction,
  json,
} from 'express'
import { Address, BufferUtil, Message, Networks } from 'xpi-ts/lib/bitcore'
import {
  PlatformConfiguration,
  type ScriptChunkPlatformUTF8,
  toProfileIdBuf,
} from 'xpi-ts/lib/rank'
import type { RuntimeState } from './state'
import { Database } from './database'
import {
  computeFullEngagement,
  getTierName,
  getTierBonus,
  computeStreakBonus,
} from './engagement'
import config from '../config'
import {
  API_SERVER_PORT,
  ERR,
  HTTP,
  REFERRAL_CODE_LENGTH,
  REFERRAL_CODE_EXPIRY_HOURS,
  REFERRAL_GENESIS_EXPIRY_HOURS,
  REFERRAL_MAX_OUTSTANDING,
  REFERRAL_MIN_VOTES,
  REFERRAL_REDEEM_IP_LIMIT,
  REFERRAL_GENESIS_REFERRER,
  FAUCET_MILESTONE_VOTES,
  FAUCET_DRIP_AMOUNTS,
} from '../util/constants'
import {
  sendJSON,
  sendAuthChallenge,
  toLogEntries,
  isValidInstanceId,
  log,
  Validate,
  type LogEntry,
} from '../util/functions'
import type { AuthorizationCache } from './api/authCache'
import type { Timespan } from './database'
import { Temporal } from './temporal'

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
  /** Array of votes within the timespan, or null if not available */
  votesTimespan: string[] | null
  /** Unique identifier for the profile */
  profileId: string
  /** The social media platform */
  platform: ScriptChunkPlatformUTF8
}
/**
 * Represents a post's ranking information, extending RankTopProfile with an optional postId
 */
export type RankTopPost = RankTopProfile & {
  postId?: string
}
/** Available API endpoint names for routing */
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
  | 'referralGenerate'
  | 'referralRedeem'
  | 'referralGenesis'
  | 'engagement'
/** Handler function type for processing API endpoint requests */
export type EndpointHandler = (
  req: Request,
  res: Response,
  next: NextFunction,
) => void
/** Available parameter names that can be validated in API endpoints */
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
/** Handler function type for validating and processing endpoint parameters */
export type EndpointParameterHandler = (
  req: Request,
  res: Response,
  next: NextFunction,
  param: string | ScriptChunkPlatformUTF8 | ChartType,
) => void

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
/** Available chart types for data visualization endpoints */
export type ChartType = 'wallet'
/** Types of chart data that can be requested */
export type ChartDataType = 'summary' | 'activity'

/** Mapping of stats route paths to their corresponding database method names */
export enum StatsRoutes {
  'profiles/top-ranked' = 'getStatsPlatformRanked',
  'profiles/lowest-ranked' = 'getStatsPlatformRanked',
  'posts/top-ranked' = 'getStatsPlatformRanked',
  'posts/lowest-ranked' = 'getStatsPlatformRanked',
}
/** Valid stats route path strings */
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
    platform: string,
  ) => {
    platform = platform.toLowerCase()
    const platformParams = PlatformConfiguration.get(
      platform as ScriptChunkPlatformUTF8,
    )
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
    const { postId: postIdParams } = PlatformConfiguration.get(platform)!
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
    chartType: string,
  ) => {
    switch (chartType as ChartType) {
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
    dataType: string,
  ) => {
    switch (dataType as ChartDataType) {
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
    searchType: string,
  ) => {
    const validated = Validate.searchType(searchType as 'profile' | 'post')
    if (validated.error) {
      return sendJSON(res, { error: validated.error }, validated.statusCode)
    }
    // searchType is validated, so it is safe to cast
    req.params.searchType = validated.searchType!
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
    const result = Validate.scriptPayload(scriptPayload)
    if (!result.scriptPayload) {
      return sendJSON(
        res,
        { error: `invalid script payload specified` },
        HTTP.BAD_REQUEST,
      )
    }
    // TODO: handle signature validation here
    req.params.scriptPayload = result.scriptPayload
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
    statsRoute: string,
  ) => {
    statsRoute = statsRoute.toLowerCase()
    // Must be a defined route
    if (!StatsRoutes[statsRoute as StatsRoute]) {
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
    // pageNum is validated, so it is safe to cast
    req.params.pageNum = pageNum!
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
    // pageSize is validated, so it is safe to cast
    req.params.pageSize = pageSize!
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
    const result = Validate.instanceId(instanceId)
    if (result.error) {
      return sendJSON(res, { ...result }, result.statusCode)
    }
    // instanceId is validated, so it is safe to cast
    req.params.instanceId = instanceId!
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
    if (!txid?.match(/^[0-9a-fA-F]{64}$/)) {
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
 * API class for handling HTTP requests and responses
 * @extends {EventEmitter}
 */
export class API extends EventEmitter {
  /** Database instance for data persistence */
  private db: Database
  /** Express application instance */
  private app: Express
  /** Cache for storing authorization tokens and session data */
  private authCache: AuthorizationCache
  /** Express router for handling API routes */
  private router: Router
  /** HTTP server instance */
  private server!: Server
  /** Runtime state containing application configuration */
  private state: RuntimeState
  /** Temporal client and worker wrapper instance */
  private temporal: Temporal

  /**
   * Initializes Express router with endpoints for profiles, posts, stats, and wallet operations.
   * Sets up parameter handlers and configures routes for both GET and POST requests.
   */
  constructor({
    authCache,
    routers,
    state,
    db,
    temporal,
  }: {
    authCache: AuthorizationCache
    routers: [string, Router][]
    state: RuntimeState
    db: Database
    temporal: Temporal
  }) {
    super()
    this.state = state
    this.db = db
    this.temporal = temporal
    //this.app = express()
    this.authCache = authCache
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
      '/wallet/summary/:instanceId/:scriptPayload/:startTime?/:endTime?',
      this.GET.wallet,
    )
    this.router.get(
      '/wallet/:instanceId/:scriptPayload/:startTime?/:endTime?',
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

    // Router GET endpoint configuration (engagement)
    this.router.get('/wallet/engagement/:scriptPayload', this.GET.engagement)

    // Router POST endpoint configuration (DEEPEST ROUTES FIRST!)
    this.router.post('/admin/referral/genesis', this.POST.referralGenesis)
    this.router.post('/referral/generate', this.POST.referralGenerate)
    this.router.post('/referral/redeem', this.POST.referralRedeem)
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
  }

  /**
   * Shutdown the API server and Temporal interfaces
   */
  async close() {
    this.server?.closeAllConnections()
    this.server?.close()
  }
  /**
   * GET Method Handlers
   */
  private GET: Partial<Record<Endpoint, EndpointHandler>> = {
    /**
     * Retrieves a paginated list of ranked profiles
     * @param req Express Request object containing `page` and `pageSize` parameters
     * @param res Express Response object to send back profiles data
     * @returns JSON response with profiles data or error message
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
     * Retrieves profile information for a specific platform and profile ID
     * @param req Express Request object containing `platform` and `profileId` parameters
     * @param res Express Response object to send back profile data
     * @returns JSON response with profile data or error message
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
     * Retrieves a single post for a platform profile
     * @param req Express Request object containing `platform`, `profileId`, `postId`, and `scriptPayload` parameters
     * @param res Express Response object to send back post data
     * @returns JSON response with post data or error message
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
          let data:
            | WalletRankActivityWorkflowResult
            | ChartWalletSummary
            | null = null
          if (dataType == 'activity') {
            // Capitalize first letter of timespan to match Temporal query type naming convention
            // e.g., 'day' -> 'Day' to form query type like 'getActivityDay'
            const timespan =
              startTime.charAt(0).toUpperCase() + startTime.slice(1)
            // Query the Temporal workflow for cached wallet activity data
            const result = await this.temporal.activities.queryWorkflow({
              workflowId: config.temporal.api.chartsWalletActivity.workflowId,
              queryType:
                config.temporal.api.chartsWalletActivity.queryType + timespan,
            })
            data = result as WalletRankActivityWorkflowResult
          }
          if (dataType == 'summary') {
            // Fetch wallet summary directly from database for aggregate statistics
            const result = await this.db.apiChartWalletSummary(startTime)
            data = result as ChartWalletSummary
          }
          const t1 = (performance.now() - t0).toFixed(3)
          log([
            ['api', 'get.charts'],
            ...toLogEntries(req.params),
            ['elapsed', `${t1}ms`],
          ])
          // Return empty object if no data was retrieved (shouldn't happen with valid dataType)
          return sendJSON(res, data ?? {}, HTTP.OK)
        }
        default:
          // This case should not be reached due to middleware validation,
          // but serves as a fallback for safety
          return sendJSON(
            res,
            { error: `invalid chart type specified` },
            HTTP.BAD_REQUEST,
          )
      }
    },

    /**
     * Searches for profiles based on a query string
     * @param req Express Request object containing `query` parameter
     * @param res Express Response object to send back search results
     * @returns JSON response with matching profiles or empty array
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
     * Retrieves statistics for profiles or posts based on ranking type and timespan
     * @param req Express Request object containing `platform`, `statsRoute`, `timespan`, `votes`, and `pageNum` parameters
     * @param res Express Response object to send back statistics data
     * @returns JSON response with statistics data or error message
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
     * Retrieves transaction data for a platform profile with pagination
     * @param req Express Request object containing `platform`, `profileId`, `page`, and `pageSize` parameters
     * @param res Express Response object to send back transaction data
     * @returns JSON response with transaction data or error message
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
     * @returns JSON response with wallet activity data or authentication challenge
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

      const authorizationHeader = req.headers['authorization']
      if (!authorizationHeader) {
        const t1 = (performance.now() - t0).toFixed(3)
        entries.push(['elapsed', `${t1}ms`])
        log(entries)
        return sendAuthChallenge(res, this.state.checkpoint)
      }

      // check if the instanceId is authorized
      if (
        !this.authCache.isRequestAuthorized(
          req.params.instanceId,
          authorizationHeader,
        )
      ) {
        const t1 = (performance.now() - t0).toFixed(3)
        entries.push(['elapsed', `${t1}ms`])
        log(entries)
        return sendAuthChallenge(res, this.state.checkpoint)
      }
      // REQUEST IS NOW AUTHORIZED

      // validate the scriptPayload GET parameter
      const validationResult = Validate.scriptPayload(req.params.scriptPayload)
      if (validationResult.error) {
        const t1 = (performance.now() - t0).toFixed(3)
        entries.push(['elapsed', `${t1}ms`])
        log(entries)
        return sendJSON(
          res,
          { error: validationResult.error },
          HTTP.BAD_REQUEST,
        )
      }

      // proceed with request
      const startTime = (req.params.startTime ?? 'today') as Timespan
      const endTime = (req.params.endTime ?? 'now') as Timespan
      try {
        const data = req.path.startsWith('/wallet/summary')
          ? await this.db.ipcGetScriptPayloadActivitySummary({
              scriptPayload: validationResult.scriptPayload,
              startTime,
              endTime,
            })
          : await this.db.ipcGetScriptPayloadActivity(
              {
                scriptPayload: validationResult.scriptPayload,
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
     * Retrieves paginated vote activity data
     * @param req Express Request object containing `page` and `pageSize` parameters
     * @param res Express Response object to send back vote activity data
     * @returns JSON response with vote activity data or error message
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

    /**
     * Retrieves the engagement profile for a wallet
     * @param req Express Request object containing `scriptPayload` parameter
     * @param res Express Response object to send back engagement data
     * @returns JSON response with engagement data or error message
     */
    engagement: async (req: Request, res: Response) => {
      const t0 = performance.now()
      const { scriptPayload } = req.params
      const validated = Validate.scriptPayload(scriptPayload)
      if (!validated.scriptPayload) {
        return sendJSON(res, { error: validated.error }, validated.statusCode)
      }
      try {
        // Compute the full engagement profile (gathers all metrics from DB)
        const engagement = await computeFullEngagement(
          this.db,
          validated.scriptPayload,
        )
        // Persist the computed engagement data
        const record = await this.db.upsertWalletEngagement(
          validated.scriptPayload,
          {
            ...engagement,
            lifetimeRewards:
              (
                await this.db.getOrCreateWalletEngagement(
                  validated.scriptPayload,
                )
              ).lifetimeRewards ?? 0n,
          },
        )
        const t1 = (performance.now() - t0).toFixed(3)
        log([
          ['api', 'get.engagement'],
          ['scriptPayload', validated.scriptPayload],
          ['tier', `${engagement.tier}`],
          ['ep', `${engagement.engagementPoints}`],
          ['elapsed', `${t1}ms`],
        ])
        return sendJSON(
          res,
          {
            scriptPayload: validated.scriptPayload,
            tier: engagement.tier,
            tierName: getTierName(engagement.tier),
            tierBonus: getTierBonus(engagement.tier),
            engagementPoints: engagement.engagementPoints,
            epBreakdown: engagement.epBreakdown,
            streakBonus: computeStreakBonus(engagement.currentStreak),
            lifetimeVotes: engagement.lifetimeVotes,
            lifetimeReferrals: engagement.lifetimeReferrals,
            lifetimeComments: engagement.lifetimeComments,
            currentStreak: engagement.currentStreak,
            longestStreak: engagement.longestStreak,
            lastVoteDate: engagement.lastVoteDate?.toISOString() ?? null,
            lifetimeRewards: record.lifetimeRewards.toString(),
            updatedAt: record.updatedAt.toISOString(),
          },
          HTTP.OK,
        )
      } catch (e) {
        const t1 = (performance.now() - t0).toFixed(3)
        log([
          ['api', 'error'],
          ['action', 'get.engagement'],
          ['scriptPayload', validated.scriptPayload],
          ['message', `"${String(e)}"`],
          ['elapsed', `${t1}ms`],
        ])
        return sendJSON(res, { error: e.message }, HTTP.INTERNAL_SERVER_ERROR)
      }
    },
  }
  /**
   * PATCH Method Handlers
   */
  private PATCH: { [name in Endpoint]?: EndpointHandler } = {
    /**
     * Updates or creates a post for a platform profile
     * @param req Express Request object containing `platform`, `profileId`, `postId` parameters and `content` in body
     * @param res Express Response object to send back post data
     * @returns JSON response with post data or error message
     */
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
     * @returns JSON response with posts data or error message
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
     * Retrieves an instance ID for client authentication
     * @param req Express Request object containing instance registration data
     * @param res Express Response object to send back instance data
     * @returns JSON response with instance data or error message
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
        validated = Validate.instanceId(body.instanceId)
        if (!validated.instanceId) {
          throw new Error(validated.error)
        }
        validated = Validate.scriptPayload(body.scriptPayload)
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
              BufferUtil.from(body.scriptPayload, 'hex'),
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
        await this.temporal.client.workflow.signalWithStart(
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

    /**
     * Generates a referral code for an authenticated user.
     * Requires BlockDataSig authentication.
     * Eligibility: user must have ≥ REFERRAL_MIN_VOTES votes and
     * fewer than REFERRAL_MAX_OUTSTANDING outstanding codes.
     *
     * @param req Express Request with body: { scriptPayload, signature }
     * @param res Express Response
     * @returns JSON response with the generated referral code
     */
    referralGenerate: async (req: Request, res: Response) => {
      const t0 = performance.now()
      try {
        const body = req.body as {
          scriptPayload: string
          signature: string
        }
        // Validate scriptPayload
        const validated = Validate.scriptPayload(body.scriptPayload)
        if (!validated.scriptPayload) {
          return sendJSON(res, { error: validated.error }, validated.statusCode)
        }
        // Verify wallet ownership via Message.verify
        const message = `generate-referral:${validated.scriptPayload}`
        try {
          const address = Address.fromPublicKeyHash(
            BufferUtil.from(validated.scriptPayload, 'hex'),
            Networks.livenet,
          )
          if (!new Message(message).verify(address, body.signature)) {
            return sendJSON(
              res,
              { error: 'invalid signature' },
              HTTP.UNAUTHORIZED,
            )
          }
        } catch {
          return sendJSON(
            res,
            { error: 'invalid signature' },
            HTTP.UNAUTHORIZED,
          )
        }
        // Check eligibility: minimum votes
        const voteCount = await this.db.countRankTxsByScriptPayload(
          validated.scriptPayload,
        )
        if (voteCount < REFERRAL_MIN_VOTES) {
          return sendJSON(
            res,
            {
              error: `must have at least ${REFERRAL_MIN_VOTES} vote(s) to generate referral codes`,
              currentVotes: voteCount,
            },
            HTTP.FORBIDDEN,
          )
        }
        // Check eligibility: outstanding code limit
        const outstanding = await this.db.countOutstandingReferralCodes(
          validated.scriptPayload,
        )
        if (outstanding >= REFERRAL_MAX_OUTSTANDING) {
          return sendJSON(
            res,
            {
              error: `maximum of ${REFERRAL_MAX_OUTSTANDING} outstanding referral codes reached`,
              outstanding,
            },
            HTTP.TOO_MANY_REQUESTS,
          )
        }
        // Generate HMAC-based referral code
        const nonce = randomBytes(16).toString('hex')
        const hmac = createHmac('sha256', config.referral.secret)
        hmac.update(`${validated.scriptPayload}:${nonce}:${Date.now()}`)
        const code = hmac.digest('hex').slice(0, REFERRAL_CODE_LENGTH)
        // Set expiration
        const expiresAt = new Date(
          Date.now() + REFERRAL_CODE_EXPIRY_HOURS * 3_600_000,
        )
        // Create the referral code in the database
        const record = await this.db.createReferralCode(
          code,
          validated.scriptPayload,
          expiresAt,
        )
        const t1 = (performance.now() - t0).toFixed(3)
        log([
          ['api', 'post.referralGenerate'],
          ['referrer', validated.scriptPayload],
          ['code', code],
          ['elapsed', `${t1}ms`],
        ])
        return sendJSON(
          res,
          {
            code: record.code,
            expiresAt: record.expiresAt.toISOString(),
            outstanding: outstanding + 1,
          },
          HTTP.CREATED,
        )
      } catch (e) {
        const t1 = (performance.now() - t0).toFixed(3)
        log([
          ['api', 'error'],
          ['action', 'post.referralGenerate'],
          ['message', `"${String(e)}"`],
          ['elapsed', `${t1}ms`],
        ])
        return sendJSON(res, { error: e.message }, HTTP.INTERNAL_SERVER_ERROR)
      }
    },

    /**
     * Redeems a referral code for a new user.
     * Creates a FaucetClaim and triggers the first faucet drip via Temporal.
     *
     * @param req Express Request with body: { code, scriptPayload, signature }
     * @param res Express Response
     * @returns JSON response with redemption result
     */
    referralRedeem: async (req: Request, res: Response) => {
      const t0 = performance.now()
      try {
        const body = req.body as {
          code: string
          scriptPayload: string
          signature: string
        }
        // Validate referral code format
        const validatedCode = Validate.referralCode(body.code)
        if (!validatedCode.code) {
          return sendJSON(
            res,
            { error: validatedCode.error },
            validatedCode.statusCode,
          )
        }
        // Validate scriptPayload
        const validated = Validate.scriptPayload(body.scriptPayload)
        if (!validated.scriptPayload) {
          return sendJSON(res, { error: validated.error }, validated.statusCode)
        }
        // Verify wallet ownership via Message.verify
        const message = `redeem-referral:${validatedCode.code}:${validated.scriptPayload}`
        try {
          const address = Address.fromPublicKeyHash(
            BufferUtil.from(validated.scriptPayload, 'hex'),
            Networks.livenet,
          )
          if (!new Message(message).verify(address, body.signature)) {
            return sendJSON(
              res,
              { error: 'invalid signature' },
              HTTP.UNAUTHORIZED,
            )
          }
        } catch {
          return sendJSON(
            res,
            { error: 'invalid signature' },
            HTTP.UNAUTHORIZED,
          )
        }
        // Check IP rate limit
        const clientIp =
          (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ||
          req.socket.remoteAddress ||
          'unknown'
        const recentRedemptions =
          await this.db.countRecentRedemptionsByIp(clientIp)
        if (recentRedemptions >= REFERRAL_REDEEM_IP_LIMIT) {
          return sendJSON(
            res,
            { error: 'too many redemptions from this IP address' },
            HTTP.TOO_MANY_REQUESTS,
          )
        }
        // Look up the referral code
        const referral = await this.db.getReferralCode(validatedCode.code)
        if (!referral) {
          return sendJSON(
            res,
            { error: 'referral code not found' },
            HTTP.NOT_FOUND,
          )
        }
        // Check if already redeemed
        if (referral.redeemedAt) {
          return sendJSON(
            res,
            { error: 'referral code has already been redeemed' },
            HTTP.CONFLICT,
          )
        }
        // Check if expired
        if (referral.expiresAt < new Date()) {
          return sendJSON(
            res,
            { error: 'referral code has expired' },
            HTTP.GONE,
          )
        }
        // Prevent self-referral
        if (referral.referrerPayload === validated.scriptPayload) {
          return sendJSON(
            res,
            { error: 'cannot redeem your own referral code' },
            HTTP.FORBIDDEN,
          )
        }
        // Check if this wallet already has a faucet claim
        const existingClaim = await this.db.getFaucetClaim(
          validated.scriptPayload,
        )
        if (existingClaim) {
          return sendJSON(
            res,
            { error: 'wallet has already redeemed a referral code' },
            HTTP.CONFLICT,
          )
        }
        // Atomically redeem the code
        await this.db.redeemReferralCode(
          validatedCode.code,
          validated.scriptPayload,
          clientIp,
        )
        // Create the faucet claim record
        await this.db.createFaucetClaim(
          validated.scriptPayload,
          validatedCode.code,
        )
        // Signal Temporal to process the first faucet drip (milestone 1)
        try {
          await this.temporal.client.workflow.signalWithStart(
            config.temporal.command.workflowType,
            {
              signal: config.temporal.command.signal,
              taskQueue: config.temporal.taskQueue,
              workflowId: config.temporal.command.workflowId,
              signalArgs: [
                {
                  action: 'faucetDrip',
                  data: {
                    scriptPayload: validated.scriptPayload,
                    milestone: 1,
                    amount: FAUCET_DRIP_AMOUNTS[0].toString(),
                    referrerPayload: referral.referrerPayload,
                  },
                },
              ],
            },
          )
        } catch (temporalError) {
          // Log but don't fail the redemption — the drip can be retried
          log([
            ['api', 'warn'],
            ['action', 'post.referralRedeem.temporal'],
            ['message', `"${String(temporalError)}"`],
          ])
        }
        const t1 = (performance.now() - t0).toFixed(3)
        log([
          ['api', 'post.referralRedeem'],
          ['redeemer', validated.scriptPayload],
          ['referrer', referral.referrerPayload],
          ['code', validatedCode.code],
          ['elapsed', `${t1}ms`],
        ])
        return sendJSON(
          res,
          {
            redeemed: true,
            referrerPayload: referral.referrerPayload,
            milestone: 1,
            dripAmount: FAUCET_DRIP_AMOUNTS[0].toString(),
          },
          HTTP.OK,
        )
      } catch (e) {
        const t1 = (performance.now() - t0).toFixed(3)
        log([
          ['api', 'error'],
          ['action', 'post.referralRedeem'],
          ['message', `"${String(e)}"`],
          ['elapsed', `${t1}ms`],
        ])
        return sendJSON(res, { error: e.message }, HTTP.INTERNAL_SERVER_ERROR)
      }
    },

    /**
     * Admin endpoint to generate genesis referral codes (batch).
     * Requires ADMIN_SECRET header authentication.
     * Used for initial onboarding before organic referral generation is possible.
     *
     * @param req Express Request with body: { count } and header: x-admin-secret
     * @param res Express Response
     * @returns JSON response with generated codes
     */
    referralGenesis: async (req: Request, res: Response) => {
      const t0 = performance.now()
      try {
        // Validate admin secret
        const adminHeader = req.headers['x-admin-secret'] as string | undefined
        const adminValidated = Validate.adminSecret(
          adminHeader,
          config.admin.secret,
        )
        if (!adminValidated.valid) {
          return sendJSON(
            res,
            { error: adminValidated.error },
            adminValidated.statusCode,
          )
        }
        const body = req.body as { count?: number }
        const count = Math.min(Math.max(body.count || 1, 1), 50)
        // Generate batch of codes
        const codes: Array<{
          code: string
          referrerPayload: string
          expiresAt: Date
        }> = []
        const expiresAt = new Date(
          Date.now() + REFERRAL_GENESIS_EXPIRY_HOURS * 3_600_000,
        )
        for (let i = 0; i < count; i++) {
          const nonce = randomBytes(16).toString('hex')
          const hmac = createHmac('sha256', config.referral.secret)
          hmac.update(
            `${REFERRAL_GENESIS_REFERRER}:${nonce}:${Date.now()}:${i}`,
          )
          const code = hmac.digest('hex').slice(0, REFERRAL_CODE_LENGTH)
          codes.push({
            code,
            referrerPayload: REFERRAL_GENESIS_REFERRER,
            expiresAt,
          })
        }
        // Batch insert
        const result = await this.db.createReferralCodeBatch(codes)
        const t1 = (performance.now() - t0).toFixed(3)
        log([
          ['api', 'post.referralGenesis'],
          ['count', `${result.count}`],
          ['elapsed', `${t1}ms`],
        ])
        return sendJSON(
          res,
          {
            created: result.count,
            codes: codes.map(c => ({
              code: c.code,
              expiresAt: c.expiresAt.toISOString(),
            })),
          },
          HTTP.CREATED,
        )
      } catch (e) {
        const t1 = (performance.now() - t0).toFixed(3)
        log([
          ['api', 'error'],
          ['action', 'post.referralGenesis'],
          ['message', `"${String(e)}"`],
          ['elapsed', `${t1}ms`],
        ])
        return sendJSON(res, { error: e.message }, HTTP.INTERNAL_SERVER_ERROR)
      }
    },
  }
}
