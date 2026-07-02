import { Router, Request, Response } from 'express'
import { Database } from '../../database'
import { sendJSON, log, toLogEntries } from '../../../util/functions'
import { HTTP } from '../../../util/constants'
import { ScriptChunkPlatformUTF8 } from 'xpi-ts/lib/rank'
import type { FeedFilterParams, Timespan } from '../../database'

export function createFeedRouter(db: Database): Router {
  const router = Router({ mergeParams: true })

  // ============================================================
  // GET /feed/posts
  // ============================================================
  router.get('/feed/posts', async (req: Request, res: Response) => {
    const t0 = performance.now()
    const entries: Array<[string, string]> = [
      ['api', 'get.feedPosts'],
      [
        'src',
        (req.headers['x-forwarded-for'] as string) ?? req.socket.remoteAddress,
      ],
      ...toLogEntries(req.params),
    ]
    try {
      const filters = {
        platform: req.query.platform as ScriptChunkPlatformUTF8,
        sortBy: (req.query.sortBy as FeedFilterParams['sortBy']) ?? undefined,
        startTime: req.query.startTime as Timespan,
        page: req.query.page ? Number(req.query.page) : undefined,
        pageSize: req.query.pageSize ? Number(req.query.pageSize) : undefined,
        scriptPayload: req.query.scriptPayload as string,
      }
      entries.push(['filters', JSON.stringify(filters)])

      const result = await db.apiGetFeedPosts(filters)
      const t1 = (performance.now() - t0).toFixed(3)
      log([
        ['api', 'get.feedPosts'],
        ['filters', JSON.stringify(filters)],
        ['results', `${result.posts.length}`],
        ['elapsed', `${t1}ms`],
      ])
      return sendJSON(res, result, HTTP.OK)
    } catch (e) {
      const t1 = (performance.now() - t0).toFixed(3)
      log([
        ['api', 'error'],
        ['action', 'get.feedPosts'],
        ['message', `"${String(e)}"`],
        ['elapsed', `${t1}ms`],
      ])
      return sendJSON(
        res,
        { error: 'feed posts not found', message: (e as Error).message },
        HTTP.NOT_FOUND,
      )
    }
  })

  // ============================================================
  // GET /feed/trending/:windowHours?/:limit?
  // ============================================================
  router.get(
    '/feed/trending/:windowHours?/:limit?',
    async (req: Request, res: Response) => {
      const t0 = performance.now()
      try {
        const windowHours = req.params.windowHours
          ? Number(req.params.windowHours)
          : 24
        const limit = req.params.limit ? Number(req.params.limit) : 20
        const scriptPayload = req.query.scriptPayload as string

        const result = await db.apiGetTrendingPosts(
          windowHours,
          limit,
          scriptPayload,
        )
        const t1 = (performance.now() - t0).toFixed(3)
        log([
          ['api', 'get.feedTrending'],
          ['windowHours', `${windowHours}`],
          ['limit', `${limit}`],
          ['results', `${result.length}`],
          ['elapsed', `${t1}ms`],
        ])
        return sendJSON(res, result, HTTP.OK)
      } catch (e) {
        const t1 = (performance.now() - t0).toFixed(3)
        log([
          ['api', 'error'],
          ['action', 'get.feedTrending'],
          ['message', `"${String(e)}"`],
          ['elapsed', `${t1}ms`],
        ])
        return sendJSON(
          res,
          { error: 'trending posts not found', message: (e as Error).message },
          HTTP.NOT_FOUND,
        )
      }
    },
  )

  // ============================================================
  // GET /feed/leaderboard/:period/:limit?
  // ============================================================
  router.get(
    '/feed/leaderboard/:period/:limit?',
    async (req: Request, res: Response) => {
      const t0 = performance.now()
      try {
        const period = req.params.period as 'daily' | 'weekly'
        const limit = req.params.limit ? Number(req.params.limit) : 20

        if (period !== 'daily' && period !== 'weekly') {
          return sendJSON(
            res,
            { error: 'period must be "daily" or "weekly"' },
            HTTP.BAD_REQUEST,
          )
        }

        const result = await db.apiGetLeaderboard(period, limit)
        const t1 = (performance.now() - t0).toFixed(3)
        log([
          ['api', 'get.leaderboard'],
          ['period', period],
          ['limit', `${limit}`],
          ['results', `${result.length}`],
          ['elapsed', `${t1}ms`],
        ])
        return sendJSON(res, result, HTTP.OK)
      } catch (e) {
        const t1 = (performance.now() - t0).toFixed(3)
        log([
          ['api', 'error'],
          ['action', 'get.leaderboard'],
          ['message', `"${String(e)}"`],
          ['elapsed', `${t1}ms`],
        ])
        return sendJSON(
          res,
          { error: 'leaderboard not found', message: (e as Error).message },
          HTTP.NOT_FOUND,
        )
      }
    },
  )

  return router
}
