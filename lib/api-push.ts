import { Server } from 'node:http'
import { EventEmitter } from 'node:events'
import express, {
  Express,
  Router,
  type Request,
  type Response,
  type NextFunction,
  json,
} from 'express'
import { Database } from './database'
import { SubscriptionManager } from './push'
import { HTTP } from '../util/constants'
import { sendJSON, log } from '../util/functions'
import type { AuthorizationCache } from './api/authCache'
import type { RuntimeState } from './state'
import type { Topic } from './push'

import { createPushRouter } from './api/routes/push'

export type EndpointParameter = 'subscriptionId' | 'topic' | 'topics'
export type EndpointParameterHandler = (
  req: Request,
  res: Response,
  next: NextFunction,
  param: string | undefined,
) => void

const PushParameters: Record<EndpointParameter, EndpointParameterHandler> = {
  subscriptionId: async (req, res, next, subscriptionId) => {
    if (!subscriptionId) {
      return sendJSON(
        res,
        { error: 'subscriptionId must be specified' },
        HTTP.BAD_REQUEST,
      )
    }
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

  topic: async (req, res, next, topic) => {
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

  topics: async (req, res, next, topics) => {
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

export class PushAPI extends EventEmitter {
  private subscriptionManager: SubscriptionManager
  private authCache: AuthorizationCache
  private state: RuntimeState
  private db: Database
  private app: Express
  private router: Router
  private server: Server
  private readonly PUSH_SERVER_PORT = 3001

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

    this.router.param('subscriptionId', PushParameters.subscriptionId)
    this.router.param('topic', PushParameters.topic)
    this.router.param('topics', PushParameters.topics)

    // Mount push sub-router
    this.router.use(
      '/',
      createPushRouter({ db, authCache, state, subscriptionManager }),
    )

    this.app = express()
    this.app.use(json())
    this.app.use('/push', this.router)
  }

  async init() {
    this.server = this.app.listen(this.PUSH_SERVER_PORT)
    log([
      ['init', 'push-api'],
      ['status', 'connected'],
      ['httpServer', 'listening'],
      ['httpServerPort', `${this.PUSH_SERVER_PORT}`],
    ])
  }

  async close() {
    this.server?.closeAllConnections()
    this.server?.close()
  }
}
