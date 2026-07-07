import { Router, Request, Response } from 'express'
import { Database } from '../../database'
import { AuthorizationCache } from '../authCache'
import type { RuntimeState } from '../../state'
import {
  sendJSON,
  sendAuthChallenge,
  log,
  toLogEntries,
} from '../../../util/functions'
import { HTTP } from '../../../util/constants'
import { validateScriptPayload } from '../../../util/validators'
import type { LogEntry } from '../../../util/functions'
import type { Timespan } from '../../database'
import { getTierName, getTierBonus, computeStreakBonus } from '../../engagement'

export function createWalletRouter(
  db: Database,
  authCache: AuthorizationCache,
  state: RuntimeState,
): Router {
  const router = Router({ mergeParams: true })

  // ============================================================
  // GET /wallet/summary/:instanceId/:scriptPayload/:startTime?/:endTime?
  // GET /wallet/:instanceId/:scriptPayload/:startTime?/:endTime?
  // ============================================================
  router.get('/wallet/summary/:instanceId/:scriptPayload/:startTime?/:endTime?', walletHandler)
  router.get('/wallet/:instanceId/:scriptPayload/:startTime?/:endTime?', walletHandler)

  async function walletHandler(req: Request, res: Response) {
    const t0 = performance.now()
    const entries: LogEntry[] = [
      ['api', 'get.wallet'],
      ['action', 'walletActivity'],
      ['src', (req.headers['x-forwarded-for'] as string) ?? req.socket.remoteAddress],
      ...toLogEntries(req.params),
    ]

    const authorizationHeader = req.headers['authorization']
    if (!authorizationHeader) {
      const t1 = (performance.now() - t0).toFixed(3)
      entries.push(['elapsed', `${t1}ms`])
      log(entries)
      return sendAuthChallenge(res, state.checkpoint)
    }

    if (!authCache.isRequestAuthorized(req.params.instanceId, authorizationHeader)) {
      const t1 = (performance.now() - t0).toFixed(3)
      entries.push(['elapsed', `${t1}ms`])
      log(entries)
      return sendAuthChallenge(res, state.checkpoint)
    }

    const validationResult = validateScriptPayload(req.params.scriptPayload)
    if (validationResult.error) {
      const t1 = (performance.now() - t0).toFixed(3)
      entries.push(['elapsed', `${t1}ms`])
      log(entries)
      return sendJSON(res, { error: validationResult.error }, HTTP.BAD_REQUEST)
    }

    const startTime = (req.params.startTime ?? 'today') as Timespan
    const endTime = (req.params.endTime ?? 'now') as Timespan
    try {
      const data = req.path.startsWith('/wallet/summary')
        ? await db.ipcGetScriptPayloadActivitySummary({
            scriptPayload: validationResult.scriptPayload,
            startTime,
            endTime,
          })
        : await db.ipcGetScriptPayloadActivity(
            { scriptPayload: validationResult.scriptPayload, startTime, endTime },
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
      return sendJSON(res, { error: (e as Error).message }, HTTP.BAD_REQUEST)
    }
  }

  // ============================================================
  // GET /wallet/engagement/:scriptPayload
  // ============================================================
  router.get('/wallet/engagement/:scriptPayload', async (req: Request, res: Response) => {
    const t0 = performance.now()
    const entries: LogEntry[] = [
      ['api', 'get.engagement'],
      ['action', 'engagement'],
      ['src', (req.headers['x-forwarded-for'] as string) ?? req.socket.remoteAddress],
      ...toLogEntries(req.params),
    ]

    const { scriptPayload } = req.params
    const validated = validateScriptPayload(scriptPayload)

    if (!validated.scriptPayload) {
      return sendJSON(res, { error: validated.error }, validated.statusCode)
    }

    try {
      const record = await db.getOrCreateWalletEngagement(validated.scriptPayload)
      const t1 = (performance.now() - t0).toFixed(3)
      entries.push(
        ['tier', `${record.tier}`],
        ['ep', `${record.engagementPoints}`],
        ['elapsed', `${t1}ms`],
      )
      log(entries)
      return sendJSON(
        res,
        {
          scriptPayload: validated.scriptPayload,
          tier: record.tier,
          tierName: getTierName(record.tier),
          tierBonus: getTierBonus(record.tier),
          engagementPoints: record.engagementPoints,
          epBreakdown: record.epBreakdown,
          streakBonus: computeStreakBonus(record.currentStreak),
          lifetimeVotes: record.lifetimeVotes,
          lifetimeReferrals: record.lifetimeReferrals,
          lifetimeComments: record.lifetimeComments,
          currentStreak: record.currentStreak,
          longestStreak: record.longestStreak,
          lastVoteDate: record.lastVoteDate?.toISOString() ?? null,
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
      return sendJSON(res, { error: (e as Error).message }, HTTP.INTERNAL_SERVER_ERROR)
    }
  })

  return router
}
