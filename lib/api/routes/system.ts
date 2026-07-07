import { Router, Request, Response } from 'express'
import { Address, BufferUtil, Message, Networks } from 'xpi-ts/lib/bitcore'
import { Database } from '../../database'
import { Temporal } from '../../temporal'
import {
  sendJSON,
  log,
  toLogEntries,
  recomputeInstanceId,
} from '../../../util/functions'
import { HTTP } from '../../../util/constants'
import { validateInstanceId, validateScriptPayload } from '../../../util/validators'
import config from '../../../config'
import { ScriptChunkPlatformUTF8 } from 'xpi-ts/lib/rank'
import type { Timespan } from '../../database'
import {
  ChartWalletSummary,
  WalletRankActivityWorkflowResult,
  ChartDataType,
  ChartType,
} from '../types'

export function createSystemRouter(db: Database, temporal: Temporal): Router {
  const router = Router({ mergeParams: true })

  // ============================================================
  // GET /charts/:chartType/:dataType/:timespan?
  // ============================================================
  router.get('/charts/:chartType/:dataType/:timespan?', async (req: Request, res: Response) => {
    const t0 = performance.now()
    const chartType = req.params.chartType as ChartType
    const dataType = req.params.dataType as ChartDataType
    const startTime = (req.params.timespan ?? 'day') as Timespan

    switch (chartType) {
      case 'wallet': {
        let data: WalletRankActivityWorkflowResult | ChartWalletSummary | null = null
        if (dataType == 'activity') {
          const timespan = startTime.charAt(0).toUpperCase() + startTime.slice(1)
          const result = await temporal.activities.queryWorkflow({
            workflowId: config.temporal.api.chartsWalletActivity.workflowId,
            queryType: config.temporal.api.chartsWalletActivity.queryType + timespan,
          })
          data = result as WalletRankActivityWorkflowResult
        }
        if (dataType == 'summary') {
          const result = await db.apiChartWalletSummary(startTime)
          data = result as ChartWalletSummary
        }
        const t1 = (performance.now() - t0).toFixed(3)
        log([
          ['api', 'get.charts'],
          ...toLogEntries(req.params),
          ['elapsed', `${t1}ms`],
        ])
        return sendJSON(res, data ?? {}, HTTP.OK)
      }
      default:
        return sendJSON(res, { error: 'invalid chart type specified' }, HTTP.BAD_REQUEST)
    }
  })

  // ============================================================
  // GET /txs/:platform/:profileId/:page?/:pageSize?
  // ============================================================
  router.get('/txs/:platform/:profileId/:page?/:pageSize?', async (req: Request, res: Response) => {
    const t0 = performance.now()
    const { platform, profileId } = req.params
    const page = Number(req.params.page)
    const pageSize = Number(req.params.pageSize)
    try {
      const result = await db.apiGetPlatformProfileVotesTableData(
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
  })

  // ============================================================
  // GET /votes/:page?/:pageSize?
  // ============================================================
  router.get('/votes/:page?/:pageSize?', async (req: Request, res: Response) => {
    const t0 = performance.now()
    const page = Number(req.params.page)
    const pageSize = Number(req.params.pageSize)
    try {
      const result = await db.apiGetVoteActivity(page, pageSize)
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
  })

  // ============================================================
  // POST /instance
  // ============================================================
  router.post('/instance', async (req: Request, res: Response) => {
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
      let validated: { scriptPayload?: string; instanceId?: string; error?: string; statusCode?: number }
      validated = validateInstanceId(body.instanceId)
      if (!validated.instanceId) {
        throw new Error(validated.error)
      }
      validated = validateScriptPayload(body.scriptPayload)
      if (!validated.scriptPayload) {
        throw new Error('scriptPayload must be specified')
      }
      if (!Date.parse(body.createdAt)) {
        throw new Error('createdAt date format is invalid')
      }
      if (!(await recomputeInstanceId(body))) {
        throw new Error('instanceId does not match input data')
      }
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
      const registrationResult = await db.registerExtension({
        id: body.instanceId,
        scriptPayload: body.scriptPayload,
        createdAt: new Date(body.createdAt),
        lastSeen: new Date(),
      })
      if (registrationResult.error) {
        throw new Error(registrationResult.error)
      }
      await temporal.client.workflow.signalWithStart(
        config.temporal.command.workflowType,
        {
          signal: config.temporal.command.signal,
          taskQueue: config.temporal.taskQueue,
          workflowId: config.temporal.command.workflowId,
          signalArgs: [{ data: body }],
        },
      )
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
      return sendJSON(res, { error: (e as Error).message, params: req.body }, HTTP.BAD_REQUEST)
    }
  })

  return router
}
