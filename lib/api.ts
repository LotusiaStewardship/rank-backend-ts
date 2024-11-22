import { Express, Router, Request, Response, NextFunction } from 'express'
import express from 'express'
import Database from './database'
import type { PlatformParameters, ScriptChunkPlatformUTF8 } from '../util/types'
import { API_SERVER_PORT, PLATFORMS } from '../util/constants'
import { log } from '../util/functions'
import { Server } from 'http'

type Endpoint = 'profile' | 'post' | 'stats'
type EndpointHandler = (req: Request, res: Response) => void
type Parameter = 'platform' | 'profileId' | 'postId'
type ParameterHandler = (
  req: Request,
  res: Response,
  next: NextFunction,
  param: ScriptChunkPlatformUTF8 | string,
) => void

export default class API {
  private db: Database
  private app: Express
  private router: Router
  private server: Server
  /**
   *
   * @param db
   */
  constructor() {
    this.db = new Database()
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
    // Router endpoint configuration
    this.router.get('/:platform/:profileId', this.get.profile)
    this.router.get('/:platform/:profileId/:postId', this.get.post)
    this.router.get(
      '/stats/top/profiles/:timeframe',
      this.getStatsTopProfilesByTimeframe,
    )
    // App/Server setup
    this.app = express()
    this.app.use('/api/v1', this.router)
  }
  /**
   * Initialze database connection and HTTP server
   */
  async init() {
    await this.db.connect()
    this.server = this.app.listen(API_SERVER_PORT)
  }
  /**
   *
   * @param exitCode
   * @param exitError
   */
  async close(exitCode: number | string, exitError?: string) {
    await this.db?.disconnect()
    this.server?.closeAllConnections()
    this.server?.close()
  }
  /**
   * Parameter Handlers
   */
  private param: {
    [param in Parameter]: ParameterHandler
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
      const platformParams = PLATFORMS[platform]
      if (!platformParams) {
        return this.sendJSON(res, { error: `invalid platform specified` }, 400)
      }
      this.app.set('platformParams', platformParams)
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
      const { profileId: profileIdParams } = this.app.get(
        'platformParams',
      ) as PlatformParameters
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
      const { postId: postIdParams } = this.app.get(
        'platformParams',
      ) as PlatformParameters
      if (!postId.match(postIdParams.regex)) {
        return this.sendJSON(res, { error: `postId is invalid format` }, 400)
      }
      let buffer: Buffer
      switch (postIdParams.type) {
        case 'BigInt':
          buffer = Buffer.from(BigInt(postId).toString(16), 'hex')
          if (buffer.length != postIdParams.chunkLength) {
            return this.sendJSON(
              res,
              { error: `postId is invalid length` },
              400,
            )
          }
          break
        case 'String':
          break
      }
      req.params.postId = postId
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
        log([
          ['api', 'error'],
          ['action', 'get.profile'],
          ...this.toLogEntries(req.params),
          ['message', `"${String(e)}"`],
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
        const { platform, profileId, postId } = req.params
        // ranking bigint converted to string before return
        const result = await this.db.apiGetPlatformProfilePost(
          platform as ScriptChunkPlatformUTF8,
          profileId,
          postId,
        )
        const t1 = (performance.now() - t0).toFixed(3)
        log([
          ['api', 'get.post'],
          ['platform', `${platform}`],
          ['profileId', `${profileId}`],
          ['postId', `${postId}`],
          ['elapsed', `${t1}ms`],
        ])
        return this.sendJSON(res, result, 200)
      } catch (e) {
        // Assume not found but log error to console
        log([
          ['api', 'error'],
          ['action', 'get.post'],
          ...this.toLogEntries(req.params),
          ['message', `"${String(e)}"`],
        ])
        return this.sendJSON(
          res,
          { error: 'post not found', params: req.params },
          404,
        )
      }
    },
  }
  /**
   *
   */
  private getStatsTopProfilesByTimeframe = async (
    req: Request,
    res: Response,
  ) => {}
  private sendJSON(res: Response, data: object, statusCode?: number) {
    res
      .contentType('application/javascript')
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
