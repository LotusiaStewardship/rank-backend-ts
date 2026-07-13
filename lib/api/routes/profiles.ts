import { Router, Request, Response } from 'express'
import { Database } from '../../database'
import { Temporal } from '../../temporal'
import {
  sendJSON,
  log,
  toLogEntries,
} from '../../../util/functions'
import { HTTP } from '../../../util/constants'
import { ScriptChunkPlatformUTF8 } from 'xpi-ts/lib/rank'
import type { FeedFilterParams, Timespan } from '../../database'
import {
  ChartType,
  ChartDataType,
  ChartWalletSummary,
  WalletRankActivityWorkflowResult,
  StatsRoutes,
  StatsRoute,
} from '../types'

export function createProfilesRouter(db: Database, temporal: Temporal): Router {
  const router = Router({ mergeParams: true })

  // ============================================================
  // GET /profiles/:page?/:pageSize?
  // ============================================================
  router.get('/profiles/:page?/:pageSize?', async (req: Request, res: Response) => {
    const t0 = performance.now()
    const page = Number(req.params.page)
    const pageSize = Number(req.params.pageSize)
    try {
      const result = await db.apiGetProfiles(page, pageSize)
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
  })

  // ============================================================
  // GET /search/:searchType/:query
  // ============================================================
  router.get('/search/:searchType/:query', async (req: Request, res: Response) => {
    const t0 = performance.now()
    const query = req.params.query ?? ''
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
      const result = await db.apiSearchProfile(query)
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
  })

  // ============================================================
  // GET /stats/:statsRoute(profiles/[a-z-]+|posts/[a-z-]+)/:timespan?/:votes?/:pageNum?
  // ============================================================
  router.get('/stats/:statsRoute(profiles/[a-z-]+|posts/[a-z-]+)/:timespan?/:votes?/:pageNum?', async (req: Request, res: Response) => {
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
      const dbMethod: keyof typeof db = StatsRoutes[statsRoute]
      const result = await (db as any)[dbMethod]({
        startTime,
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
  })

  // ============================================================
  // GET /:platform/:profileId
  // ============================================================
  router.get('/:platform/:profileId', async (req: Request, res: Response) => {
    const t0 = performance.now()
    try {
      const { platform, profileId } = req.params
      const scriptPayload = req.query.scriptPayload as string
      const result = await db.apiGetPlatformProfile(
        platform as ScriptChunkPlatformUTF8,
        profileId,
        scriptPayload,
      )
      const t1 = (performance.now() - t0).toFixed(3)
      log([
        ['api', 'get.profile'],
        ['platform', `${platform}`],
        ['profileId', `${profileId}`],
        ['scriptPayload', `${req.query.scriptPayload}`],
        ['elapsed', `${t1}ms`],
      ])
      return sendJSON(res, result, HTTP.OK)
    } catch (e) {
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
  })

  // ============================================================
  // GET /:platform/:profileId/posts/:page?/:pageSize?
  // ============================================================
  router.get('/:platform/:profileId/posts/:page?/:pageSize?', async (req: Request, res: Response) => {
    const t0 = performance.now()
    const { platform, profileId } = req.params
    const page = Number(req.params.page)
    const pageSize = Number(req.params.pageSize)
    try {
      const result = await db.apiGetPlatformProfilePosts({
        platform: platform as ScriptChunkPlatformUTF8,
        profileId,
        scriptPayload: req.query.scriptPayload as string | undefined,
        page,
        pageSize,
      })
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
  })

  // ============================================================
  // GET /:platform/:profileId/:postId
  // ============================================================
  router.get('/:platform/:profileId/:postId', async (req: Request, res: Response) => {
    const t0 = performance.now()
    try {
      const { platform, profileId, postId } = req.params
      const result = await db.apiGetPlatformProfilePost(
        platform as ScriptChunkPlatformUTF8,
        profileId,
        postId,
        req.query.scriptPayload as string | undefined,
      )
      log([
        ['api', 'get.post'],
        ...toLogEntries(req.params),
        ['elapsed', `${(performance.now() - t0).toFixed(3)}ms`],
      ])
      return sendJSON(res, result, HTTP.OK)
    } catch (e) {
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
  })

  // ============================================================
  // POST /posts/:platform/:scriptPayload
  // ============================================================
  router.post('/posts/:platform/:scriptPayload', async (req: Request, res: Response) => {
    const t0 = performance.now()
    if (req.headers['content-type'] !== 'application/json') {
      return sendJSON(res, { error: 'invalid content type' }, HTTP.BAD_REQUEST)
    }
    const { platform, scriptPayload } = req.params
    if (!scriptPayload) {
      return sendJSON(res, { error: 'scriptPayload invalid or not specified' }, HTTP.BAD_REQUEST)
    }
    const body = Array.from(req.body) as Array<{ profileId: string; postId: string }>
    try {
      const result = await db.apiGetPlatformPosts(
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
  })

  return router
}
