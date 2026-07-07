import { Server } from 'node:http'
import { EventEmitter } from 'node:events'
import express, { Express, Router, json } from 'express'
import { rateLimit } from 'express-rate-limit'
import {
  PlatformConfiguration,
  type ScriptChunkPlatformUTF8,
  toProfileIdBuf,
} from 'xpi-ts/lib/rank'
import type { RuntimeState } from '../state'
import { Database } from '../database'
import { Temporal } from '../temporal'
import { AuthorizationCache } from './authCache'
import { API_SERVER_PORT, HTTP } from '../../util/constants'
import { sendJSON, sendRateLimitExceededJSON, log } from '../../util/functions'
import {
  validateScriptPayload,
  validateInstanceId,
  validateSearchType,
} from '../../util/validators'
import type { ChartType, EndpointParameter, EndpointParameterHandler } from './types'
import { StatsRoutes } from './types'
import config from '../../config'
import type { Request, Response, NextFunction } from 'express'

import { createProfilesRouter } from './routes/profiles'
import { createFeedRouter } from './routes/feed'
import { createWalletRouter } from './routes/wallet'
import { createReferralRouter } from './routes/referral'
import { createSystemRouter } from './routes/system'
import { createPushRouter } from './routes/push'
import { SubscriptionManager } from '../push'

/**
 * Checks that the provided parameters are valid and sets the request parameters
 */
const Parameters: Record<EndpointParameter, EndpointParameterHandler> = {
  platform: async (req, res, next, platform: string) => {
    platform = platform.toLowerCase()
    const platformParams = PlatformConfiguration.get(
      platform as ScriptChunkPlatformUTF8,
    )
    if (!platformParams) {
      return sendJSON(
        res,
        { error: 'invalid platform specified' },
        HTTP.BAD_REQUEST,
      )
    }
    req.params.platform = platform
    next()
  },

  profileId: async (req, res, next, profileId: string) => {
    profileId = profileId.toLowerCase()
    const platform = req.params.platform as ScriptChunkPlatformUTF8
    if (toProfileIdBuf(platform, profileId) === null) {
      return sendJSON(
        res,
        { error: 'invalid profileId specified' },
        HTTP.BAD_REQUEST,
      )
    }
    req.params.profileId = profileId
    next()
  },

  postId: async (req, res, next, postId: string) => {
    postId = postId.toLowerCase()
    const platform = req.params.platform as ScriptChunkPlatformUTF8
    const { postId: postIdParams } = PlatformConfiguration.get(platform)!
    if (!postId.match(postIdParams.regex)) {
      return sendJSON(
        res,
        { error: 'postId is invalid format' },
        HTTP.BAD_REQUEST,
      )
    }
    switch (postIdParams.type) {
      case 'BigInt': {
        const buffer = Buffer.from(BigInt(postId).toString(16), 'hex')
        if (buffer.length != postIdParams.len) {
          return sendJSON(
            res,
            { error: 'postId is invalid length' },
            HTTP.BAD_REQUEST,
          )
        }
        break
      }
      case 'String':
        break
    }
    req.params.postId = postId
    next()
  },

  chartType: async (req, res, next, chartType: string) => {
    switch (chartType as ChartType) {
      case 'wallet':
        break
      default:
        return sendJSON(
          res,
          { error: 'invalid chart type specified' },
          HTTP.BAD_REQUEST,
        )
    }
    req.params.chartType = chartType
    next()
  },

  dataType: async (req, res, next, dataType: string) => {
    switch (dataType as import('./types').ChartDataType) {
      case 'activity':
      case 'summary':
        break
      default:
        return sendJSON(
          res,
          { error: 'invalid chart data type specified' },
          HTTP.BAD_REQUEST,
        )
    }
    req.params.dataType = dataType
    next()
  },

  searchType: async (req, res, next, searchType: string) => {
    const validated = validateSearchType(searchType as 'profile' | 'post')
    if (validated.error) {
      return sendJSON(res, { error: validated.error }, validated.statusCode)
    }
    req.params.searchType = validated.searchType!
    next()
  },

  scriptPayload: async (req, res, next, scriptPayload: string | undefined) => {
    const result = validateScriptPayload(scriptPayload)
    if (!result.scriptPayload) {
      return sendJSON(res, { error: result.error }, result.statusCode)
    }
    req.params.scriptPayload = result.scriptPayload
    next()
  },

  statsRoute: async (req, res, next, statsRoute: string) => {
    statsRoute = statsRoute.toLowerCase()
    if (!StatsRoutes[statsRoute as keyof typeof StatsRoutes]) {
      return sendJSON(
        res,
        { error: 'invalid stats path specified' },
        HTTP.BAD_REQUEST,
      )
    }
    req.params.statsRoute = statsRoute
    next()
  },

  pageNum: async (req, res, next, pageNum: string | undefined) => {
    if (isNaN(Number(pageNum))) {
      return sendJSON(
        res,
        { error: 'invalid votes page number specified' },
        HTTP.BAD_REQUEST,
      )
    }
    req.params.pageNum = pageNum!
    next()
  },

  pageSize: async (req, res, next, pageSize: string | undefined) => {
    const pageSizeNum = Number(pageSize)
    if (isNaN(pageSizeNum) || pageSizeNum < 1) {
      return sendJSON(
        res,
        { error: 'invalid page size specified' },
        HTTP.BAD_REQUEST,
      )
    }
    if (pageSizeNum > 40) {
      pageSize = '40'
    }
    req.params.pageSize = pageSize!
    next()
  },

  instanceId: async (req, res, next, instanceId: string | undefined) => {
    const result = validateInstanceId(instanceId)
    if (result.error) {
      return sendJSON(res, { ...result }, result.statusCode)
    }
    req.params.instanceId = instanceId!
    next()
  },

  txid: async (req, res, next, txid: string | undefined) => {
    if (!txid?.match(/^[0-9a-fA-F]{64}$/)) {
      return sendJSON(
        res,
        { error: 'invalid txid specified' },
        HTTP.BAD_REQUEST,
      )
    }
    req.params.txid = txid
    next()
  },
}

export class API extends EventEmitter {
  private db: Database
  private app: Express
  private authCache: AuthorizationCache
  private router: Router
  private server!: Server
  private state: RuntimeState
  private temporal: Temporal

  constructor({
    authCache,
    routers,
    state,
    db,
    temporal,
    subscriptionManager,
  }: {
    authCache: AuthorizationCache
    routers: [string, Router][]
    state: RuntimeState
    db: Database
    temporal: Temporal
    subscriptionManager: SubscriptionManager
  }) {
    super()
    this.state = state
    this.db = db
    this.temporal = temporal
    this.authCache = authCache
    this.router = Router({
      caseSensitive: false,
      mergeParams: true,
      strict: true,
    })

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

    // Mount sub-routers
    const subRouters: [string, Router][] = [
      ['/', createProfilesRouter(db, temporal)],
      ['/', createFeedRouter(db)],
      ['/', createWalletRouter(db, authCache, state)],
      ['/', createReferralRouter(db, temporal)],
      ['/', createSystemRouter(db, temporal)],
      ['/push', createPushRouter({ db, authCache, state, subscriptionManager })],
      ...routers,
    ]
    for (const [prefix, subRouter] of subRouters) {
      this.router.use(prefix, subRouter)
    }

    this.app = express()
    this.app.use(json())
    this.app.use('/api/v1', this.router)

    this.app.use(
      rateLimit({
        windowMs: config.api.rateLimitWindowMinutes * 60 * 1000,
        limit: config.api.rateLimitMaxRequests,
        standardHeaders: true,
        legacyHeaders: false,
        skip: () => false,
        handler: sendRateLimitExceededJSON,
      }),
    )
  }

  async init() {
    this.server = this.app.listen(API_SERVER_PORT)
    log([
      ['init', 'api'],
      ['status', 'connected'],
      ['httpServer', 'listening'],
      ['httpServerPort', `${API_SERVER_PORT}`],
    ])
  }

  async close() {
    this.server?.closeAllConnections()
    this.server?.close()
  }
}
