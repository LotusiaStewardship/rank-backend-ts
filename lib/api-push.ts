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
import { Database } from './database'
import { SubscriptionManager } from './push'
import { HTTP } from '../util/constants'
import {
  log,
  LogEntry,
  sendAuthChallenge,
  sendJSON,
  sendAndLogError,
  extractScriptPayload,
} from '../util/functions'
import type { AuthorizationCache } from './api/authCache'
import type { RuntimeState } from './state'
import type { Topic, PushSubscriptionEndpoint } from './push'

interface PushSubscriptionPayload {
  /** The instance ID */
  instanceId: string
  /** The push subscription data */
  endpoint: PushSubscriptionEndpoint
  /** The topic to subscribe to */
  topic: Topic
}

// Push API endpoint types
/* export type Endpoint =
  | 'subscription'
  | 'message'
  | 'instance'
  | 'userSubscriptions'
  | 'topicSubscriptions'
  | 'subscribe'
  | 'sendMessage'
  | 'sendMessageToInstance'
  | 'addTopics'
  | 'extendSubscription'
  | 'unsubscribe'
  | 'unsubscribeTopic'
  | 'removeTopics' */
export type Endpoint =
  | 'subscribe'
  | 'unsubscribe'
  | 'subscribeTopic'
  | 'unsubscribeTopic'
export type EndpointHandler = (req: Request, res: Response) => void
export type EndpointParameter = 'subscriptionId' | 'topic' | 'topics'
export type EndpointParameterHandler = (
  req: Request,
  res: Response,
  next: NextFunction,
  param: string | undefined,
) => void

/**
 * Validates that the provided parameters are valid and sets the request parameters
 */
const PushParameters: Record<EndpointParameter, EndpointParameterHandler> = {
  /**
   * Validates that the provided `subscriptionId` is a valid UUID.
   * If invalid, responds with HTTP 400 and an error message.
   */
  subscriptionId: async (
    req: Request,
    res: Response,
    next: NextFunction,
    subscriptionId: string | undefined,
  ) => {
    if (!subscriptionId) {
      return sendJSON(
        res,
        { error: 'subscriptionId must be specified' },
        HTTP.BAD_REQUEST,
      )
    }
    // Basic UUID validation
    const uuidRegex =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    if (!uuidRegex.test(subscriptionId)) {
      return sendJSON(
        res,
        { error: 'invalid subscriptionId format' },
        HTTP.BAD_REQUEST,
      )
    }
    req.params.subscriptionId = subscriptionId
    next()
  },
  /**
   * Validates that the provided `topic` is a valid topic name.
   * If invalid, responds with HTTP 400 and an error message.
   */
  topic: async (
    req: Request,
    res: Response,
    next: NextFunction,
    topic: string | undefined,
  ) => {
    if (!topic) {
      return sendJSON(
        res,
        { error: 'topic must be specified' },
        HTTP.BAD_REQUEST,
      )
    }
    if (topic.length < 1 || topic.length > 32) {
      return sendJSON(
        res,
        { error: 'topic must be between 1 and 32 characters' },
        HTTP.BAD_REQUEST,
      )
    }
    if (!SubscriptionManager.validateTopic(topic as Topic)) {
      return sendJSON(res, { error: 'invalid topic format' }, HTTP.BAD_REQUEST)
    }
    req.params.topic = topic
    next()
  },
  /**
   * Validates that the provided `topics` is a valid comma-separated list of topics.
   * If invalid, responds with HTTP 400 and an error message.
   */
  topics: async (
    req: Request,
    res: Response,
    next: NextFunction,
    topics: string | undefined,
  ) => {
    if (!topics) {
      return sendJSON(
        res,
        { error: 'topics must be specified' },
        HTTP.BAD_REQUEST,
      )
    }
    const topicList = topics.split(',').map(t => t.trim())
    for (const topic of topicList) {
      if (topic.length < 1 || topic.length > 32) {
        return sendJSON(
          res,
          { error: 'each topic must be between 1 and 32 characters' },
          HTTP.BAD_REQUEST,
        )
      }
    }
    req.params.topics = topics
    next()
  },
}

/**
 * Push API class for handling HTTP requests and responses for push notifications
 * @extends {EventEmitter}
 */
export class PushAPI extends EventEmitter {
  private subscriptionManager: SubscriptionManager
  private authCache: AuthorizationCache
  private state: RuntimeState
  private db: Database
  private app: Express
  private router: Router
  private server: Server
  private readonly PUSH_SERVER_PORT = 3001
  /**
   * Initializes Express router with endpoints for push subscription management
   * Sets up parameter handlers and configures routes for GET, POST, PATCH, and DELETE requests
   * @param pushManager PushSubscriptionManager instance for handling push operations
   * @extends {EventEmitter} Inherits event handling capabilities
   */
  constructor({
    subscriptionManager,
    authCache,
    state,
    db,
  }: {
    subscriptionManager: SubscriptionManager
    authCache: AuthorizationCache
    state: RuntimeState
    db: Database
  }) {
    super()
    this.subscriptionManager = subscriptionManager
    this.authCache = authCache
    this.state = state
    this.db = db
    this.router = Router({
      caseSensitive: false,
      mergeParams: true,
      strict: true,
    })

    // Router parameter configuration
    this.router.param('subscriptionId', PushParameters.subscriptionId)
    this.router.param('topic', PushParameters.topic)
    this.router.param('topics', PushParameters.topics)

    // Router GET endpoint configuration (DEEPEST ROUTES FIRST!)
    //this.router.get('/stats', this.GET.stats)
    //this.router.get('/vapid', this.GET.vapid)
    //this.router.get('/subscriptions/:instanceId', this.GET.userSubscriptions)
    //this.router.get('/subscription/:subscriptionId', this.GET.subscription)
    //this.router.get('/topics/:topic/subscriptions', this.GET.topicSubscriptions)

    // Router POST endpoint configuration (DEEPEST ROUTES FIRST!)
    //this.router.post('/message/user/:instanceId', this.POST.sendMessageToUser)
    //this.router.post('/message', this.POST.sendMessage)
    this.router.post(
      '/subscription/:instanceId/topic/:topic',
      this.POST.subscribeTopic,
    )
    this.router.post('/subscription/:instanceId', this.POST.subscribe)

    // Router PATCH endpoint configuration (DEEPEST ROUTES FIRST!)
    //this.router.patch(
    //  '/subscription/:subscriptionId/topics',
    //  this.PATCH.addTopics,
    //)
    //this.router.patch(
    //  '/subscription/:subscriptionId/extend',
    //  this.PATCH.extendSubscription,
    //)

    // Router DELETE endpoint configuration (DEEPEST ROUTES FIRST!)
    this.router.delete(
      '/subscription/:subscriptionId/topic/:topic',
      this.DELETE.unsubscribeTopic,
    )
    this.router.delete('/subscription/:instanceId', this.DELETE.unsubscribe)
    //this.router.delete(
    //  '/subscription/:subscriptionId/topics',
    //  this.DELETE.removeTopics,
    //)
    //this.router.delete('/unsubscribe/:instanceId', this.DELETE.unsubscribe)

    // App/Server setup
    this.app = express()
    this.app.use(json())
    this.app.use('/push', this.router)
  }

  /**
   * Initialize the push API server
   */
  async init() {
    this.server = this.app.listen(this.PUSH_SERVER_PORT)
    log([
      ['init', 'push-api'],
      ['status', 'connected'],
      ['httpServer', 'listening'],
      ['httpServerPort', `${this.PUSH_SERVER_PORT}`],
    ])
  }

  /**
   * Shutdown the push API server
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
     * Gets push subscription statistics
     */
    /* stats: async (req: Request, res: Response) => {
      const t0 = performance.now()
      try {
        const result = await this.subscriptionManager.getStats()
        const t1 = (performance.now() - t0).toFixed(3)
        log([
          ['push-api', 'get.stats'],
          ['elapsed', `${t1}ms`],
        ])
        return sendJSON(res, result, HTTP.OK)
      } catch (e) {
        const t1 = (performance.now() - t0).toFixed(3)
        log([
          ['push-api', 'error'],
          ['action', 'get.stats'],
          ['message', `"${String(e)}"`],
          ['elapsed', `${t1}ms`],
        ])
        return sendJSON(
          res,
          { error: 'failed to get stats' },
          HTTP.INTERNAL_SERVER_ERROR,
        )
      }
    }, */
    /**
     * Gets VAPID public key for client configuration
     */
    /*  vapid: async (req: Request, res: Response) => {
      const t0 = performance.now()
      try {
        const result = {
          publicKey: this.subscriptionManager.getVapidPublicKey(),
        }
        const t1 = (performance.now() - t0).toFixed(3)
        log([
          ['push-api', 'get.vapid'],
          ['elapsed', `${t1}ms`],
        ])
        return sendJSON(res, result, HTTP.OK)
      } catch (e) {
        const t1 = (performance.now() - t0).toFixed(3)
        log([
          ['push-api', 'error'],
          ['action', 'get.vapid'],
          ['message', `"${String(e)}"`],
          ['elapsed', `${t1}ms`],
        ])
        return sendJSON(
          res,
          { error: 'failed to get VAPID key' },
          HTTP.INTERNAL_SERVER_ERROR,
        )
      }
    }, */
    /**
     * Gets all subscriptions for a user
     */
    /* userSubscriptions: async (req: Request, res: Response) => {
      const t0 = performance.now()
      const { instanceId } = req.params
      try {
        const result =
          this.subscriptionManager.getInstanceSubscriptions(instanceId)
        const t1 = (performance.now() - t0).toFixed(3)
        log([
          ['push-api', 'get.userSubscriptions'],
          ['instanceId', instanceId],
          ['elapsed', `${t1}ms`],
        ])
        return sendJSON(res, result, HTTP.OK)
      } catch (e) {
        const t1 = (performance.now() - t0).toFixed(3)
        log([
          ['push-api', 'error'],
          ['action', 'get.userSubscriptions'],
          ['instanceId', instanceId],
          ['message', `"${String(e)}"`],
          ['elapsed', `${t1}ms`],
        ])
        return sendJSON(
          res,
          { error: 'failed to get user subscriptions' },
          HTTP.INTERNAL_SERVER_ERROR,
        )
      }
    }, */
    /**
     * Gets a specific subscription by ID
     */
    /* subscription: async (req: Request, res: Response) => {
      const t0 = performance.now()
      const { subscriptionId } = req.params
      try {
        const result = this.subscriptionManager.getSubscription(subscriptionId)
        const t1 = (performance.now() - t0).toFixed(3)
        log([
          ['push-api', 'get.subscription'],
          ['subscriptionId', subscriptionId],
          ['found', String(!!result)],
          ['elapsed', `${t1}ms`],
        ])
        if (!result) {
          return sendJSON(
            res,
            { error: 'subscription not found' },
            HTTP.NOT_FOUND,
          )
        }
        return sendJSON(res, result, HTTP.OK)
      } catch (e) {
        const t1 = (performance.now() - t0).toFixed(3)
        log([
          ['push-api', 'error'],
          ['action', 'get.subscription'],
          ['subscriptionId', subscriptionId],
          ['message', `"${String(e)}"`],
          ['elapsed', `${t1}ms`],
        ])
        return sendJSON(
          res,
          { error: 'failed to get subscription' },
          HTTP.INTERNAL_SERVER_ERROR,
        )
      }
    }, */
    /**
     * Gets all subscriptions for a topic
     */
    /* topicSubscriptions: async (req: Request, res: Response) => {
      const t0 = performance.now()
      const { topic } = req.params
      try {
        const result = this.subscriptionManager.getTopicSubscriptions(topic)
        const t1 = (performance.now() - t0).toFixed(3)
        log([
          ['push-api', 'get.topicSubscriptions'],
          ['topic', topic],
          ['elapsed', `${t1}ms`],
        ])
        return sendJSON(res, result, HTTP.OK)
      } catch (e) {
        const t1 = (performance.now() - t0).toFixed(3)
        log([
          ['push-api', 'error'],
          ['action', 'get.topicSubscriptions'],
          ['topic', topic],
          ['message', `"${String(e)}"`],
          ['elapsed', `${t1}ms`],
        ])
        return sendJSON(
          res,
          { error: 'failed to get topic subscriptions' },
          HTTP.INTERNAL_SERVER_ERROR,
        )
      }
    },*/
  }

  /**
   * POST Method Handlers
   */
  private POST: Partial<Record<Endpoint, EndpointHandler>> = {
    /**
     * Subscribes an extension instance to the desired `topic`
     */
    subscribe: async (req: Request, res: Response) => {
      const t0 = performance.now()
      const entries = [
        ['push-api', 'post.subscription'],
        ['action', 'subscribe'],
        ['instanceId', req.params.instanceId],
      ] as LogEntry[]

      // ensure instanceId request parameter exists
      if (!req.params.instanceId) {
        return sendAndLogError(
          res,
          'instanceId is required',
          [...entries, ['elapsed', `${(performance.now() - t0).toFixed(3)}ms`]],
          HTTP.BAD_REQUEST,
        )
      }

      // ensure content type is application/json
      if (req.headers['content-type'] !== 'application/json') {
        console.log('invalid content type')
        return sendAndLogError(
          res,
          'invalid content type',
          [...entries, ['elapsed', `${(performance.now() - t0).toFixed(3)}ms`]],
          HTTP.BAD_REQUEST,
        )
      }

      // ensure instanceId and endpoint are present in the request body
      const body = req.body as PushSubscriptionPayload
      if (!body?.instanceId || !body?.endpoint) {
        return sendAndLogError(
          res,
          'instanceId and endpoint are required',
          [...entries, ['elapsed', `${(performance.now() - t0).toFixed(3)}ms`]],
          HTTP.BAD_REQUEST,
        )
      }

      // these constants are available now, so deconstruct them
      const { instanceId, endpoint } = body

      // send auth challenge to client if not authorized to proceed
      if (
        !this.authCache.isRequestAuthorized(
          instanceId, // instanceId from request body
          req.headers['authorization'],
        )
      ) {
        const t1 = (performance.now() - t0).toFixed(3)
        entries.push(['elapsed', `${t1}ms`])
        log(entries)
        return sendAuthChallenge(res, this.state.checkpoint)
      }
      // REQUEST IS NOW AUTHORIZED

      try {
        const scriptPayload = extractScriptPayload(req.headers['authorization'])
        // register the extension in the database first
        // this will establish foreign key for instance subscription
        await this.db.registerExtension({
          id: instanceId,
          scriptPayload,
          createdAt: new Date(),
          lastSeen: new Date(),
        })
        const subscriptionId = await this.subscriptionManager.subscribe({
          instanceId,
          endpoint,
          isActive: true,
        })

        // send welcome notification to client
        await this.subscriptionManager.sendNotificationToInstance({
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
        log([...entries, ['error', e.message]])
        return sendAndLogError(
          res,
          'failed to save push subscription, please contact the Lotusia Stewardship',
          [...entries, ['elapsed', `${(performance.now() - t0).toFixed(3)}ms`]],
          HTTP.BAD_REQUEST,
        )
      }
    },
    /**
     * Subscribes an extension instance to a specific topic
     */
    subscribeTopic: async (req: Request, res: Response) => {
      const t0 = performance.now()
      const entries = [
        ['push-api', 'post.subscribeTopic'],
        ['action', 'subscribeTopic'],
        ['instanceId', req.params.instanceId],
        ['topic', req.params.topic],
      ] as LogEntry[]

      // ensure instanceId and topic are present in the request parameters
      if (!req.params.instanceId || !req.params.topic) {
        return sendAndLogError(
          res,
          'instanceId and topic are required',
          entries,
          HTTP.BAD_REQUEST,
        )
      }

      // ensure instanceId and topic are present in the request body
      if (!req.body?.instanceId || !req.body?.topic) {
        return sendAndLogError(
          res,
          'instanceId and topic are required in request body',
          entries,
          HTTP.BAD_REQUEST,
        )
      }

      // these constants are available now, so deconstruct them
      const { instanceId, topic } = req.body as PushSubscriptionPayload

      // send auth challenge to client if not authorized to proceed
      if (
        !this.authCache.isRequestAuthorized(
          instanceId, // instanceId from request body
          req.headers['authorization'],
        )
      ) {
        const t1 = (performance.now() - t0).toFixed(3)
        entries.push(['elapsed', `${t1}ms`])
        log(entries)
        return sendAuthChallenge(res, this.state.checkpoint)
      }
      // REQUEST IS NOW AUTHORIZED

      if (!SubscriptionManager.validateTopic(topic)) {
        return sendAndLogError(
          res,
          'invalid topic',
          [...entries, ['elapsed', `${(performance.now() - t0).toFixed(3)}ms`]],
          HTTP.BAD_REQUEST,
        )
      }

      try {
        await this.subscriptionManager.subscribeTopic({
          instanceId,
          topic,
        })

        const t1 = (performance.now() - t0).toFixed(3)
        log([...entries, ['success', 'true'], ['elapsed', `${t1}ms`]])
        return sendJSON(res, { success: true }, HTTP.CREATED)
      } catch (e) {
        const t1 = (performance.now() - t0).toFixed(3)
        return sendAndLogError(
          res,
          e.message,
          [...entries, ['success', 'false'], ['elapsed', `${t1}ms`]],
          HTTP.BAD_REQUEST,
        )
      }
    },
  }

  /**
   * PATCH Method Handlers
   */
  private PATCH: Partial<Record<Endpoint, EndpointHandler>> = {
    /**
     * Adds topics to an existing subscription
     */
    /* addTopics: async (req: Request, res: Response) => {
      const t0 = performance.now()
      const { subscriptionId } = req.params
      if (req.headers['content-type'] !== 'application/json') {
        return sendJSON(
          res,
          { error: 'invalid content type' },
          HTTP.BAD_REQUEST,
        )
      }

      const { topics } = req.body

      if (!topics || !Array.isArray(topics)) {
        return sendJSON(
          res,
          { error: 'topics array is required' },
          HTTP.BAD_REQUEST,
        )
      }

      try {
        const success = this.subscriptionManager.addTopics(
          subscriptionId,
          topics,
        )
        const t1 = (performance.now() - t0).toFixed(3)
        log([
          ['push-api', 'patch.addTopics'],
          ['subscriptionId', subscriptionId],
          ['topics', topics.join(',')],
          ['success', String(success)],
          ['elapsed', `${t1}ms`],
        ])
        return sendJSON(res, { success }, HTTP.OK)
      } catch (e) {
        const t1 = (performance.now() - t0).toFixed(3)
        log([
          ['push-api', 'error'],
          ['action', 'patch.addTopics'],
          ['subscriptionId', subscriptionId],
          ['message', `"${String(e)}"`],
          ['elapsed', `${t1}ms`],
        ])
        return sendJSON(res, { error: e.message }, HTTP.BAD_REQUEST)
      }
    }, */
    /**
     * Extends the expiry of a subscription
     */
    /* extendSubscription: async (req: Request, res: Response) => {
      const t0 = performance.now()
      const { subscriptionId } = req.params
      if (req.headers['content-type'] !== 'application/json') {
        return sendJSON(
          res,
          { error: 'invalid content type' },
          HTTP.BAD_REQUEST,
        )
      }

      const { days } = req.body

      if (!days || typeof days !== 'number' || days <= 0) {
        return sendJSON(
          res,
          { error: 'positive number of days is required' },
          HTTP.BAD_REQUEST,
        )
      }

      try {
        const success = this.subscriptionManager.extendSubscription(
          subscriptionId,
          days,
        )
        const t1 = (performance.now() - t0).toFixed(3)
        log([
          ['push-api', 'patch.extendSubscription'],
          ['subscriptionId', subscriptionId],
          ['days', String(days)],
          ['success', String(success)],
          ['elapsed', `${t1}ms`],
        ])
        return sendJSON(res, { success }, HTTP.OK)
      } catch (e) {
        const t1 = (performance.now() - t0).toFixed(3)
        log([
          ['push-api', 'error'],
          ['action', 'patch.extendSubscription'],
          ['subscriptionId', subscriptionId],
          ['message', `"${String(e)}"`],
          ['elapsed', `${t1}ms`],
        ])
        return sendJSON(res, { error: e.message }, HTTP.BAD_REQUEST)
      }
    }, */
  }

  /**
   * DELETE Method Handlers
   */
  private DELETE: Partial<Record<Endpoint, EndpointHandler>> = {
    /**
     * Unsubscribes from a subscription (removes specific topics or entire subscription)
     */
    unsubscribeTopic: async (req: Request, res: Response) => {
      const t0 = performance.now()
      const { subscriptionId } = req.params
      const { topic } = req.query

      try {
        const topicsToRemove = topic ? [topic as Topic] : undefined
        const success = this.subscriptionManager.unsubscribeTopic(
          subscriptionId,
          topic as Topic,
        )
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
        return sendJSON(res, { error: e.message }, HTTP.BAD_REQUEST)
      }
    },

    /**
     * Removes topics from a subscription
     */
    /* removeTopics: async (req: Request, res: Response) => {
      const t0 = performance.now()
      const { subscriptionId } = req.params
      if (req.headers['content-type'] !== 'application/json') {
        return sendJSON(
          res,
          { error: 'invalid content type' },
          HTTP.BAD_REQUEST,
        )
      }

      const { topics } = req.body as { topics: Topic[] }

      if (!topics || !Array.isArray(topics)) {
        return sendJSON(
          res,
          { error: 'topics array is required' },
          HTTP.BAD_REQUEST,
        )
      }

      try {
        const success = this.subscriptionManager.removeTopics(
          subscriptionId,
          topics,
        )
        const t1 = (performance.now() - t0).toFixed(3)
        log([
          ['push-api', 'delete.removeTopics'],
          ['subscriptionId', subscriptionId],
          ['topics', topics.join(',')],
          ['success', String(success)],
          ['elapsed', `${t1}ms`],
        ])
        return sendJSON(res, { success }, HTTP.OK)
      } catch (e) {
        const t1 = (performance.now() - t0).toFixed(3)
        log([
          ['push-api', 'error'],
          ['action', 'delete.removeTopics'],
          ['subscriptionId', subscriptionId],
          ['message', `"${String(e)}"`],
          ['elapsed', `${t1}ms`],
        ])
        return sendJSON(res, { error: e.message }, HTTP.BAD_REQUEST)
      }
    }, */

    /**
     * Unsubscribes a user from all their subscriptions
     */
    unsubscribe: async (req: Request, res: Response) => {
      const entries = [
        ['push-api', 'delete.unsubscribe'],
        ['action', 'unsubscribe'],
        ['instanceId', req.params.instanceId],
      ] as LogEntry[]
      const t0 = performance.now()
      const { instanceId } = req.params

      // check if the instanceId is authorized
      if (
        !this.authCache.isRequestAuthorized(
          instanceId,
          req.headers['authorization'],
        )
      ) {
        const t1 = (performance.now() - t0).toFixed(3)
        entries.push(['elapsed', `${t1}ms`])
        log(entries)
        return sendAuthChallenge(res, this.state.checkpoint)
      }
      // REQUEST IS NOW AUTHORIZED

      // proceed with request
      try {
        const success = this.subscriptionManager.unsubscribe(instanceId)
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
        return sendJSON(res, { error: e.message }, HTTP.BAD_REQUEST)
      }
    },
  }
}
