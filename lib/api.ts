/* eslint-disable @typescript-eslint/no-duplicate-enum-values */
import { Express, Router, Request, Response, NextFunction } from 'express'
import express from 'express'
import Database from './database'
import { API_SERVER_PORT } from '../util/constants'
import { PLATFORMS, log, type ScriptChunkPlatformUTF8 } from 'rank-lib'
import { Server } from 'http'
import { EventEmitter } from 'events'

type Timespan = 'day' | 'week' | 'month' | 'quarter' | 'all'
type Endpoint = 'profile' | 'post' | 'stats'
type EndpointHandler = (req: Request, res: Response) => void
type EndpointParameter =
  | 'platform'
  | 'profileId'
  | 'postId'
  | 'scriptPayload'
  | 'statsRoute'
  | 'pageNum'
type EndpointParameterHandler = (
  req: Request,
  res: Response,
  next: NextFunction,
  param: ScriptChunkPlatformUTF8 | string,
) => void

enum StatsRoutes {
  'profiles/top-ranked' = 'getStatsPlatformRanked',
  'profiles/lowest-ranked' = 'getStatsPlatformRanked',
  'posts/top-ranked' = 'getStatsPlatformRanked',
  'posts/lowest-ranked' = 'getStatsPlatformRanked',
}
type StatsRoute = keyof typeof StatsRoutes

export default class API extends EventEmitter {
  private db: Database
  private app: Express
  private router: Router
  private server: Server
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
    // Router endpoint configuration (DEEPEST ROUTES FIRST!)
    this.router.get(
      '/stats/:platform/:statsRoute(profiles/[a-z-]+|posts/[a-z-]+)/:timespan?/:votes?/:pageNum?',
      this.get.stats,
    )
    this.router.get(
      '/:platform/:profileId/:postId/:scriptPayload',
      this.get.post,
    )
    this.router.get('/:platform/:profileId/:postId', this.get.post)
    this.router.get('/:platform/:profileId', this.get.profile)
    // App/Server setup
    this.app = express()
    this.app.use('/api/v1', this.router)
    // App settings
    this.app.set('platformParams', PLATFORMS)
  }
  /**
   * Initialze database connection and HTTP server
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
   *
   * @param exitCode
   * @param exitError
   */
  async close() {
    this.server?.closeAllConnections()
    this.server?.close()
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
        return this.sendJSON(res, { error: `invalid platform specified` }, 400)
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
        return this.sendJSON(res, { error: `profileId is invalid length` }, 400)
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
        return this.sendJSON(res, { error: `postId is invalid format` }, 400)
      }
      switch (postIdParams.type) {
        case 'BigInt': {
          const buffer = Buffer.from(BigInt(postId).toString(16), 'hex')
          if (buffer.length != postIdParams.chunkLength) {
            return this.sendJSON(
              res,
              { error: `postId is invalid length` },
              400,
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
      const p2pkhBuf = Buffer.from(scriptPayload ?? '', 'hex')
      req.params.scriptPayload =
        p2pkhBuf.byteLength === 20 ? scriptPayload : undefined
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
          400,
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
          400,
        )
      }
      req.params.pageNum = pageNum
      next()
    },
  }
  /**
   * GET Method Handlers
   */
  private get: { [name in Endpoint]: EndpointHandler } = {
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
        return this.sendJSON(res, result, 200)
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
          404,
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
        return this.sendJSON(res, result, 200)
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
          404,
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
        const timespan = req.params.timespan as Timespan
        const votes = Boolean(req.params.votes == 'includeVotes')
        const pageNum = Number(req.params.pageNum)
        const dbMethod: keyof typeof this.db = StatsRoutes[statsRoute]
        const result = await this.db[dbMethod](
          platform,
          timespan,
          dataType,
          rankingType,
          votes,
          pageNum,
        )
        const t1 = (performance.now() - t0).toFixed(3)
        log([
          ['api', 'get.stats'],
          ...this.toLogEntries(req.params),
          ['elapsed', `${t1}ms`],
        ])
        return this.sendJSON(res, result, 200)
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
          404,
        )
      }
    },
  }
  /**
   *
   * @param res
   * @param data
   * @param statusCode
   */
  private sendJSON(res: Response, data: object, statusCode?: number) {
    res
      .contentType('application/json')
      .status(statusCode ?? 200)
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
