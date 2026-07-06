import { Router, Request, Response } from 'express'
import { Database } from '../../database'
import {
  SubscriptionManager,
  type Topic,
  type PushSubscriptionEndpoint,
} from '../../push'
import { AuthorizationCache } from '../authCache'
import type { RuntimeState } from '../../state'
import {
  sendJSON,
  sendAuthChallenge,
  sendAndLogError,
  log,
  extractScriptPayload,
  type LogEntry,
} from '../../../util/functions'
import { HTTP } from '../../../util/constants'

interface PushSubscriptionPayload {
  instanceId: string
  endpoint: PushSubscriptionEndpoint
  topic: Topic
}

export function createPushRouter(deps: {
  db: Database
  authCache: AuthorizationCache
  state: RuntimeState
  subscriptionManager: SubscriptionManager
}): Router {
  const { db, authCache, state, subscriptionManager } = deps
  const router = Router({ mergeParams: true })

  // ============================================================
  // POST /subscription/:instanceId
  // ============================================================
  router.post('/subscription/:instanceId', async (req: Request, res: Response) => {
    const t0 = performance.now()
    const entries: LogEntry[] = [
      ['push-api', 'post.subscription'],
      ['action', 'subscribe'],
      ['instanceId', req.params.instanceId],
    ]

    if (!req.params.instanceId) {
      return sendAndLogError(
        res,
        'instanceId is required',
        [...entries, ['elapsed', `${(performance.now() - t0).toFixed(3)}ms`]],
        HTTP.BAD_REQUEST,
      )
    }

    if (req.headers['content-type'] !== 'application/json') {
      return sendAndLogError(
        res,
        'invalid content type',
        [...entries, ['elapsed', `${(performance.now() - t0).toFixed(3)}ms`]],
        HTTP.BAD_REQUEST,
      )
    }

    const body = req.body as PushSubscriptionPayload
    if (!body?.instanceId || !body?.endpoint) {
      return sendAndLogError(
        res,
        'instanceId and endpoint are required',
        [...entries, ['elapsed', `${(performance.now() - t0).toFixed(3)}ms`]],
        HTTP.BAD_REQUEST,
      )
    }

    const { instanceId, endpoint } = body

    if (!authCache.isRequestAuthorized(instanceId, req.headers['authorization'])) {
      const t1 = (performance.now() - t0).toFixed(3)
      entries.push(['elapsed', `${t1}ms`])
      log(entries)
      return sendAuthChallenge(res, state.checkpoint)
    }

    try {
      const scriptPayload = extractScriptPayload(req.headers['authorization'])
      await db.registerExtension({
        id: instanceId,
        scriptPayload,
        createdAt: new Date(),
        lastSeen: new Date(),
      })
      const subscriptionId = await subscriptionManager.subscribe({
        instanceId,
        endpoint,
        isActive: true,
      })

      await subscriptionManager.sendNotificationToInstance({
        instanceId,
        message: {
          title: 'Push notifications are enabled',
          body: 'These notifications will appear when there is new activity in Lotusia',
          timestamp: Date.now(),
        },
      })

      const t1 = (performance.now() - t0).toFixed(3)
      log([
        ...entries,
        ['subscriptionId', '<redacted>'],
        ['elapsed', `${t1}ms`],
      ])

      return sendJSON(res, { subscriptionId }, HTTP.CREATED)
    } catch (e) {
      log([...entries, ['error', (e as Error).message]])
      return sendAndLogError(
        res,
        'failed to save push subscription, please contact the Lotusia Stewardship',
        [...entries, ['elapsed', `${(performance.now() - t0).toFixed(3)}ms`]],
        HTTP.BAD_REQUEST,
      )
    }
  })

  // ============================================================
  // POST /subscription/:instanceId/topic/:topic
  // ============================================================
  router.post('/subscription/:instanceId/topic/:topic', async (req: Request, res: Response) => {
    const t0 = performance.now()
    const entries: LogEntry[] = [
      ['push-api', 'post.subscribeTopic'],
      ['action', 'subscribeTopic'],
      ['instanceId', req.params.instanceId],
      ['topic', req.params.topic],
    ]

    if (!req.params.instanceId || !req.params.topic) {
      return sendAndLogError(
        res,
        'instanceId and topic are required',
        entries,
        HTTP.BAD_REQUEST,
      )
    }

    if (!req.body?.instanceId || !req.body?.topic) {
      return sendAndLogError(
        res,
        'instanceId and topic are required in request body',
        entries,
        HTTP.BAD_REQUEST,
      )
    }

    const { instanceId, topic } = req.body as PushSubscriptionPayload

    if (!SubscriptionManager.validateTopic(topic)) {
      return sendAndLogError(
        res,
        'invalid topic',
        [...entries, ['elapsed', `${(performance.now() - t0).toFixed(3)}ms`]],
        HTTP.BAD_REQUEST,
      )
    }

    if (!authCache.isRequestAuthorized(instanceId, req.headers['authorization'])) {
      const t1 = (performance.now() - t0).toFixed(3)
      entries.push(['elapsed', `${t1}ms`])
      log(entries)
      return sendAuthChallenge(res, state.checkpoint)
    }

    try {
      await subscriptionManager.subscribeTopic({ instanceId, topic })
      const t1 = (performance.now() - t0).toFixed(3)
      log([...entries, ['success', 'true'], ['elapsed', `${t1}ms`]])
      return sendJSON(res, { success: true }, HTTP.CREATED)
    } catch (e) {
      const t1 = (performance.now() - t0).toFixed(3)
      return sendAndLogError(
        res,
        (e as Error).message,
        [...entries, ['success', 'false'], ['elapsed', `${t1}ms`]],
        HTTP.BAD_REQUEST,
      )
    }
  })

  // ============================================================
  // DELETE /subscription/:subscriptionId/topic/:topic
  // ============================================================
  router.delete('/subscription/:subscriptionId/topic/:topic', async (req: Request, res: Response) => {
    const t0 = performance.now()
    const entries: LogEntry[] = [
      ['push-api', 'delete.unsubscribeTopic'],
      ['subscriptionId', req.params.subscriptionId],
      ['topic', String(req.query.topic)],
    ]
    const { subscriptionId } = req.params
    const { topic } = req.query
    const instanceId = req.body?.instanceId

    if (!authCache.isRequestAuthorized(instanceId, req.headers['authorization'])) {
      const t1 = (performance.now() - t0).toFixed(3)
      entries.push(['elapsed', `${t1}ms`])
      log(entries)
      return sendAuthChallenge(res, state.checkpoint)
    }

    try {
      const topicsToRemove = topic ? [topic as Topic] : undefined
      const success = subscriptionManager.unsubscribeTopic(subscriptionId, topic as Topic)
      const t1 = (performance.now() - t0).toFixed(3)
      log([
        ['push-api', 'delete.unsubscribe'],
        ['subscriptionId', subscriptionId],
        ['topics', topicsToRemove?.join(',') || 'all'],
        ['success', String(success)],
        ['elapsed', `${t1}ms`],
      ])
      return sendJSON(res, { success }, HTTP.OK)
    } catch (e) {
      const t1 = (performance.now() - t0).toFixed(3)
      log([
        ['push-api', 'error'],
        ['action', 'delete.unsubscribe'],
        ['subscriptionId', subscriptionId],
        ['message', `"${String(e)}"`],
        ['elapsed', `${t1}ms`],
      ])
      return sendJSON(res, { error: (e as Error).message }, HTTP.BAD_REQUEST)
    }
  })

  // ============================================================
  // DELETE /subscription/:instanceId
  // ============================================================
  router.delete('/subscription/:instanceId', async (req: Request, res: Response) => {
    const entries: LogEntry[] = [
      ['push-api', 'delete.unsubscribe'],
      ['action', 'unsubscribe'],
      ['instanceId', req.params.instanceId],
    ]
    const t0 = performance.now()
    const { instanceId } = req.params

    if (!authCache.isRequestAuthorized(instanceId, req.headers['authorization'])) {
      const t1 = (performance.now() - t0).toFixed(3)
      entries.push(['elapsed', `${t1}ms`])
      log(entries)
      return sendAuthChallenge(res, state.checkpoint)
    }

    try {
      const success = subscriptionManager.unsubscribe(instanceId)
      const t1 = (performance.now() - t0).toFixed(3)
      log([
        ['push-api', 'delete.unsubscribeInstance'],
        ['instanceId', instanceId],
        ['success', String(success)],
        ['elapsed', `${t1}ms`],
      ])
      return sendJSON(res, { success }, HTTP.OK)
    } catch (e) {
      const t1 = (performance.now() - t0).toFixed(3)
      log([
        ['push-api', 'error'],
        ['action', 'delete.unsubscribeInstance'],
        ['instanceId', instanceId],
        ['message', `"${String(e)}"`],
        ['elapsed', `${t1}ms`],
      ])
      return sendJSON(res, { error: (e as Error).message }, HTTP.BAD_REQUEST)
    }
  })

  return router
}
