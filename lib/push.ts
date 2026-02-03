import { randomUUID } from 'node:crypto'
import EventEmitter from 'node:events'
import {
  sendNotification,
  generateVAPIDKeys,
  setVapidDetails,
  setGCMAPIKey,
  type VapidKeys,
  HttpsProxyAgentOptions,
  SendResult,
} from 'web-push'
import { URL } from 'url'
import config from '../config'
import { Database } from './database'
import {
  isBase64,
  log,
  type LogEntry,
  toAsyncIterable,
} from '../util/functions'

/**
 * The endpoint URL and keys of the subscribed client (e.g. Chrome extension instance)
 * to which push messages are to be sent.
 */
export interface PushSubscriptionEndpoint {
  url: string
  keys: {
    p256dh: string
    auth: string
  }
}
export type Topic = TopicWallet | TopicStewardship | TopicSystem | TopicSocial
export type TopicWallet =
  `${(typeof TopicCategory)['wallet']}:${TopicCategoryWallet}`
export type TopicStewardship =
  `${(typeof TopicCategory)['stewardship']}:${TopicCategoryStewardship}`
export type TopicSystem =
  `${(typeof TopicCategory)['system']}:${TopicCategorySystem}`
export type TopicSocial =
  `${(typeof TopicCategory)['social']}:${TopicCategorySocial}`

/** Received from extension instance when subscribing to notifications */
export interface PushSubscriptionRequest {
  instanceId: string
  isActive: boolean
  endpoint: PushSubscriptionEndpoint
}

/** Received from extension instance when subscribing to topic notifications */
export interface TopicSubscriptionRequest {
  instanceId: string
  topic: Topic
  action: 'subscribe' | 'unsubscribe'
}

/** A push subscription request that was processed and assigned an ID */
export interface PushSubscription extends PushSubscriptionRequest {
  id: string
  /* topics?: Set<Topic> */
  createdAt: Date
  lastUsed: Date
  expiresAt?: Date
  userAgent?: string
}

export interface PushSubscriptionPayload extends PushSubscription {
  scriptPayload: string
  lastSeen: Date
}
/**
 * A topic subscription request that was processed and assigned the ID of the
 * parent Push subscription
 */
export interface TopicSubscription {
  subscriptionId: string
  instanceId: string
  topic: Topic
  isActive: boolean
  createdAt: Date
  lastUsed: Date
}

// Message payload structure
export interface PushNotification {
  title: string
  body: string
  icon?: string
  badge?: string
  image?: string
  topic?: Topic
  data?: Record<string, unknown>
  actions?: Array<{
    action: string
    title: string
    icon?: string
  }>
  requireInteraction?: boolean
  silent?: boolean
  timestamp?: number
  url?: string
}

// VAPID configuration
export interface VapidConfig {
  publicKey: string
  privateKey: string
  subject: string // Usually a mailto: or https: URL
}

// GCM configuration for legacy browser support
export interface GCMConfig {
  apiKey: string
}

// Push message options matching web-push library
export interface PushNotificationOptions {
  TTL?: number // Time to live in seconds (default: 4 weeks)
  urgency?: 'very-low' | 'low' | 'normal' | 'high' // Message urgency
  topic?: string // Topic for notification coalescing (max 32 chars)
  contentEncoding?: 'aesgcm' | 'aes128gcm' // Content encoding (default: aes128gcm)
  headers?: Record<string, string> // Additional headers
  timeout?: number // Request timeout in milliseconds
  proxy?: string | HttpsProxyAgentOptions // Proxy server options
}

// Subscription statistics
export interface SubscriptionStats {
  totalSubscriptions: number
  activeSubscriptions: number
  subscriptionsByTopic: Record<string, number>
  subscriptionsByInstance: Record<string, number>
}

// Queue message for batched notification processing
export interface QueuedNotification {
  id: string
  topics: Topic[]
  message: PushNotification
  instanceIds?: string[]
  options?: PushNotificationOptions
  createdAt: Date
  priority?: 'low' | 'normal' | 'high'
}

// Map for queued notifications (key is notification ID)
export type NotificationQueue = Map<string, QueuedNotification>
/**
 * Categories for push notification subscriptions.
 *
 * - `wallet`: Notifications related to wallet operations (e.g. new incoming transaction).
 * - `stewardship`: Notifications related to stewardship actions or responsibilities.
 * - `system`: System-level notifications, such as updates or alerts.
 * - `social`: Social notifications, such as interactions or messages.
 */
export enum TopicCategory {
  'wallet',
  'stewardship',
  'system',
  'social',
}
export enum TopicCategoryWallet {
  'incomingTransaction',
}
export enum TopicCategoryStewardship {
  'stewardship',
}
export enum TopicCategorySystem {
  'maintenance',
}
export enum TopicCategorySocial {
  //'profileUpvoted',
  //'profileDownvoted',
  'postUpvoted',
  //'postDownvoted',
  //'commentUpvoted',
  //'commentDownvoted',
}
/**
 * PushSubscriptionManager class for managing push subscriptions
 *
 * QUEUE SYSTEM USAGE:
 *
 * The SubscriptionManager now includes a queue system for batched notification processing,
 * similar to the profileQueue system in the Indexer class. This allows other modules to
 * queue notifications for efficient batch processing.
 *
 * Example usage from other modules:
 *
 * ```typescript
 * // Queue a notification for later processing
 * const queueId = subscriptionManager.queueNotification({
 *   topics: ['s', 'w'], // stewardship and wallet topics
 *   message: {
 *     title: 'New Activity',
 *     body: 'You have new activity on your profile',
 *     url: 'https://example.com/profile'
 *   },
 *   priority: 'high'
 * });
 *
 * // Process all queued notifications
 * const results = await subscriptionManager.processNotificationQueue();
 * console.log(`Sent ${results.sent} notifications, ${results.failed} failed`);
 *
 * // Or queue and process immediately
 * const results = await subscriptionManager.queueAndProcessNotification({
 *   topics: ['s'],
 *   message: { title: 'Alert', body: 'Important message' }
 * });
 *
 * // Use existing methods with queue option
 * await subscriptionManager.sendNotificationToTopics({
 *   topics: ['w'],
 *   message: { title: 'Wallet Update', body: 'Balance changed' },
 *   useQueue: true,
 *   priority: 'normal'
 * });
 * ```
 */
export class SubscriptionManager extends EventEmitter {
  /**
   * Generate VAPID keys for Web Push authentication
   * This should be done once and the keys stored securely
   */
  public static generateVAPIDKeys(): VapidKeys {
    return generateVAPIDKeys()
  }
  /**
   * Validates whether a given topic string is a valid topic according to the defined
   * TopicCategory and its subcategories.
   *
   * The topic string must be in the format "<category>:<subcategory>", where:
   * - <category> is a single character representing the topic category.
   * - <subcategory> is a single character representing the topic subcategory.
   *
   * @param topic The topic string to validate.
   * @returns Returns true if the topic is valid, false otherwise.
   */
  public static validateTopic(topic: Topic): boolean {
    // 2nd character must be a colon
    if (topic.charAt(1) !== ':') return false
    if (topic.length < 3 || topic.length > 5) return false

    const category = topic.charAt(0)
    const subcategory = topic.charAt(2)
    //const tail = topic.slice(3) // may use this in the future for fun stuff 😏

    // check each category and return a coerced boolean value
    switch (category) {
      case TopicCategory.stewardship.toString():
        switch (subcategory) {
          case TopicCategoryStewardship.stewardship.toString():
            return true
          default:
            return false
        }
      case TopicCategory.system.toString():
        switch (subcategory) {
          case TopicCategorySystem.maintenance.toString():
            return true
          default:
            return false
        }
      case TopicCategory.social.toString():
        switch (subcategory) {
          case TopicCategorySocial.postUpvoted.toString():
            return true
          default:
            return false
        }
    }
    return false
  }
  /**
   * Validates a push subscription endpoint object to ensure it conforms to the expected structure and encoding.
   *
   * The endpoint object must have:
   * - A valid URL string in the `url` property.
   * - A `keys` object containing:
   *   - `p256dh`: a URL-safe base64-encoded string that decodes to exactly 65 bytes.
   *   - `auth`: a URL-safe base64-encoded string that decodes to exactly 16 bytes.
   *
   * @param endpoint The push subscription endpoint object to validate.
   * @returns Returns true if the endpoint is valid, false otherwise.
   */
  public static validateEndpoint(endpoint: PushSubscriptionEndpoint): boolean {
    // Check if basic structure exists
    if (!endpoint || !endpoint.url || !endpoint.keys) return false
    // Validate endpoint URL format
    if (typeof endpoint.url !== 'string') return false
    // Validate keys structure
    if (!endpoint.keys.p256dh || !endpoint.keys.auth) return false

    // Validate p256dh key format (base64)
    if (!isBase64(endpoint.keys.p256dh)) return false
    // Validate auth key format (base64)
    if (!isBase64(endpoint.keys.auth)) return false

    try {
      // Try to instantiate URL class from endpoint URL
      new URL(endpoint.url)
      // Validate p256dh key format (base64, 65 bytes when decoded)
      const p256dhBuffer = Buffer.from(endpoint.keys.p256dh, 'base64')
      console.log('p256dhBuffer', p256dhBuffer)
      if (p256dhBuffer.length !== 65) {
        return false
      }
      // Validate auth key format (base64, 16 bytes when decoded)
      const authBuffer = Buffer.from(endpoint.keys.auth, 'base64')
      console.log('authBuffer', authBuffer)
      if (authBuffer.length !== 16) {
        return false
      }
    } catch {
      return false
    }

    return true
  }
  /**
   * Database instance for storing push subscriptions.
   */
  private db: Database
  /**
   * Map of subscription IDs to `PushSubscription` objects.
   * Used to store all active push subscriptions and their subscribed topics.
   */
  private subscriptions: Map<string, PushSubscription>
  /**
   * Map of topic names to sets of subscription IDs.
   * Used to track which subscriptions are associated with which topics.
   */
  private topicSubscriptions: Map<string, Set<string>>
  /**
   * Map of instance IDs to subscription IDs.
   * Used to track which subscriptions belong to which users.
   *
   * Each instance has only one subscription ID
   */
  private instanceSubscriptions: Map<string, string>
  /**
   * Map of profile IDs to instance IDs.
   * Used to track which social media profiles belong to which users.
   * Key is `profileId` and value is `instanceId`
   */
  private profileInstances: Map<string, string>
  /**
   * Queue for batched notification processing.
   * Used to accumulate notifications from other modules before processing.
   */
  private notificationQueue: NotificationQueue
  /**
   * VAPID configuration for Web Push authentication.
   */
  private vapidConfig: VapidConfig
  /**
   * Optional GCM configuration for legacy browser support.
   */
  private gcmConfig?: GCMConfig
  /**
   * Interval timer for periodic cleanup of expired subscriptions.
   */
  private cleanupInterval: NodeJS.Timeout | null = null
  /**
   * Default number of days until a subscription expires.
   */
  private readonly DEFAULT_EXPIRY_DAYS = 30
  /**
   * Interval in milliseconds for running the cleanup process (default: 24 hours).
   */
  private readonly CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000 // 24 hours
  /**
   * Constructor for PushSubscriptionManager.
   *
   * @param {VapidConfig} vapidConfig The VAPID configuration for Web Push authentication.
   * @param {GCMConfig} [gcmConfig] Optional GCM configuration for legacy browser support.
   */
  constructor(db: Database) {
    super()
    this.db = db
    // runtime cache
    this.subscriptions = new Map()
    this.topicSubscriptions = new Map()
    this.instanceSubscriptions = new Map()
    this.notificationQueue = new Map()
    // runtime config
    this.vapidConfig = config.push.vapid
    this.gcmConfig = config.push.gcm
    // set the global VAPID configuration for all web-push functions
    setVapidDetails(
      this.vapidConfig.subject,
      this.vapidConfig.publicKey,
      this.vapidConfig.privateKey,
    )
    // Configure GCM API key if provided (for legacy browser support)
    if (this.gcmConfig.apiKey) {
      setGCMAPIKey(this.gcmConfig.apiKey)
    }
    // Start cleanup interval
    //this.startCleanupInterval() // don't use this right now
  }
  /**
   * Initializes the push subscription manager by loading all subscriptions and their associated topics
   * from the database into the runtime caches.
   *
   * @returns A promise that resolves when initialization is complete.
   */
  public async init(): Promise<void> {
    const subscriptions = await this.db.getPushSubscriptions()
    for await (const subscription of toAsyncIterable(subscriptions)) {
      // destructure the subscription and set up the appropriate objects
      const {
        id: subscriptionId,
        instanceId,
        endpoint: url,
        p256dhKey,
        authKey,
        isActive,
        createdAt,
        lastUsed,
        instance: { topicSubscriptions },
      } = subscription
      const endpoint: PushSubscriptionEndpoint = {
        url,
        keys: {
          p256dh: p256dhKey,
          auth: authKey,
        },
      }
      // load the subscription into the runtime cache
      this.subscriptions.set(subscriptionId, {
        id: subscriptionId,
        instanceId,
        endpoint,
        isActive: isActive,
        createdAt: createdAt,
        lastUsed: lastUsed,
      })
      // subscribe this instanceId to the active topics
      for (const topicSubscription of topicSubscriptions) {
        const { topic, isActive } = topicSubscription
        if (isActive) {
          this.subscribeTopic({ instanceId, topic: topic as Topic })
        }
      }
    }
  }
  /**
   * Stops the cleanup interval and processes any remaining queued notifications (call when shutting down).
   *
   * @returns {Promise<void>} Returns a promise that resolves when shutdown is complete.
   */
  public async close(): Promise<void> {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval)
      this.cleanupInterval = null
    }

    // Process any remaining queued notifications before shutting down
    if (this.notificationQueue.size > 0) {
      try {
        const results = await this.processNotificationQueue()
        log([
          ['push', 'shutdown'],
          ['action', 'processNotificationQueue'],
          ['processed', `${results.processed}`],
          ['sent', `${results.sent}`],
          ['failed', `${results.failed}`],
        ])
      } catch (error) {
        log([
          ['push', 'shutdown'],
          ['action', 'processNotificationQueue'],
          ['status', 'error'],
          ['error', error.message],
        ])
      }
    }

    // TODO: commit all runtime caches to database

    //for (const [, subscription] of this.subscriptions) {
    //  this.removeSubscription(subscription.id)
    //}
  }
  /**
   * Saves the Push subscription details to runtime caches and commits to database.
   *
   * @param instanceId The unique identifier of the instance.
   * @param subscriptionData The push subscription data from the client.
   * @param topic The topic to subscribe the instance to.
   * @param userAgent Optional user agent string of the subscriber.
   * @param expiryDays Optional number of days until the subscription expires.
   * @returns The unique subscription ID.
   * @throws If the subscription data is invalid or no topics are specified.
   */
  public async subscribe({
    instanceId,
    endpoint,
  }: PushSubscriptionRequest): Promise<string> {
    // Validate subscription data
    if (!SubscriptionManager.validateEndpoint(endpoint)) {
      throw new Error('invalid push subscription data')
    }

    const subscriptionId = randomUUID()
    const now = new Date()

    const subscription: PushSubscription = {
      id: subscriptionId,
      instanceId,
      endpoint,
      isActive: true,
      /* topics: new Set(topics), */
      createdAt: now,
      lastUsed: now,
    }

    // TODO: add database operations here
    await this.db.upsertPushSubscription(subscription)

    // Store subscription
    this.subscriptions.set(subscriptionId, subscription)
    this.instanceSubscriptions.set(instanceId, subscriptionId)

    return subscriptionId
  }
  /**
   * Subscribes an instance to a specific topic.
   *
   * This function associates a topic with an existing push subscription for the given instance.
   * If the instance does not have a valid subscription, the operation fails.
   */
  public async subscribeTopic({
    instanceId,
    topic,
  }: {
    instanceId: string
    topic: Topic
  }): Promise<string> {
    // get the parent subscription ID if we have it
    const { id: subscriptionId } = this.subscriptions.get(instanceId) ?? {
      id: undefined,
    }
    if (!subscriptionId) return undefined
    // get the subscription ID of the parent Push subscription
    const now = new Date()
    const topicSubscription: TopicSubscription = {
      subscriptionId,
      instanceId,
      topic,
      isActive: true,
      createdAt: now,
      lastUsed: now,
    }

    // TODO: add database operations here
    await this.db.upsertTopicSubscription(topicSubscription)

    if (!this.topicSubscriptions.has(topic)) {
      this.topicSubscriptions.set(topic, new Set())
    }
    this.topicSubscriptions.get(topic)!.add(subscriptionId)

    return subscriptionId
  }
  /**
   * Unsubscribes an instance from all of their active subscriptions.
   *
   * @param instanceId The unique identifier of the user whose subscriptions should be removed.
   * @returns Returns true if the user had subscriptions and they were removed, false otherwise.
   */
  public async unsubscribe(instanceId: string): Promise<boolean> {
    const subscriptionId = this.instanceSubscriptions.get(instanceId)
    if (!subscriptionId) return false

    // Use synchronous iteration for removal operations since they're fast and don't involve I/O
    this.removeSubscription(subscriptionId)

    // TODO: add database operations here
    await this.db.deletePushSubscription(subscriptionId)

    return true
  }
  /**
   * Unsubscribes a user from all topics or from specific topics for a given subscription.
   *
   * @param subscriptionId The unique identifier of the subscription to unsubscribe.
   * @param [topics] Optional. An array of topic names to unsubscribe from. If omitted, unsubscribes from all topics and removes the subscription.
   * @returns Returns true if the operation was successful, false if the subscription was not found.
   */
  public async unsubscribeTopic(
    subscriptionId: string,
    topic: Topic,
  ): Promise<boolean> {
    const subscription = this.subscriptions.get(subscriptionId)
    if (!subscription) return false

    const topicSubs = this.topicSubscriptions.get(topic)
    if (topicSubs) {
      topicSubs.delete(subscriptionId)
      if (topicSubs.size === 0) {
        this.topicSubscriptions.delete(topic)
      }
    }

    const topicSubscription = {
      subscriptionId,
      instanceId: subscription.instanceId,
      topic,
      isActive: false,
      lastUsed: new Date(),
    } as TopicSubscription
    await this.db.upsertTopicSubscription(topicSubscription)

    return true
  }
  /**
   * Updates both the `PushSubscription` and `TopicSubscription` runtime caches with
   * the associated `suscriptionId` and `topics` array.
   *
   * The `PushSubscription` cache must already have the subscription laoded into memory,
   * else this will return false and no changes will be made.
   *
   * @param subscriptionId The unique identifier of the subscription to add topics to.
   * @param topics An array of topic names to add to the subscription.
   * @returns {boolean} Returns true if the topics were added successfully, false if the subscription was not found or is inactive.
   */
  public addTopics(subscriptionId: string, topics: Topic[]): boolean {
    const subscription = this.subscriptions.get(subscriptionId)
    if (!subscription || !subscription.isActive) return false
    if (!topics || topics.length === 0) return false

    for (const topic of topics) {
      //subscription.topics.add(topic)
      if (!this.topicSubscriptions.has(topic)) {
        this.topicSubscriptions.set(topic, new Set())
      }
      this.topicSubscriptions.get(topic)!.add(subscriptionId)
    }
    // TODO: probably makes more sense to set `lastUsed` when we actually send
    // a notification to the endpoint
    subscription.lastUsed = new Date()

    return true
  }
  /**
   * Removes topics from an existing instance subscription
   *
   * @param subscriptionId The unique identifier of the subscription to remove topics from.
   * @param topics An array of topic names to remove from the subscription.
   * @returns Returns true if the topics were removed successfully, false if the subscription was not found or is inactive.
   */
  public removeTopics(subscriptionId: string, topics: Topic[]): boolean {
    const subscription = this.subscriptions.get(subscriptionId)
    if (!subscription) return false

    for (const topic of topics) {
      //subscription.topics.delete(topic)
      const topicSubs = this.topicSubscriptions.get(topic)
      if (!topicSubs) continue
      topicSubs.delete(subscriptionId)
      // If no subscriptions left, remove the topic
      if (!topicSubs.size) this.topicSubscriptions.delete(topic)
    }

    subscription.lastUsed = new Date()

    // If no topics left, remove the subscription
    //if (!subscription.topics.size) this.removeSubscription(subscriptionId)

    return true
  }
  /**
   * Sends a push message to subscribers of specific topics.
   *
   * @param {PushSubscriptionTopic[]} topics An array of topic names to send the message to.
   * @param {PushNotification} message The message to send.
   * @param {string[]} [instanceIds] Optional. An array of user IDs to send the message to. If omitted, sends to all subscribers of the topics.
   * @param {PushNotificationOptions} [options] Optional. Additional options for the message.
   * @param {boolean} [useQueue] Optional. If true, adds the notification to the queue instead of sending immediately. Defaults to false.
   * @param {'low' | 'normal' | 'high'} [priority] Optional. Priority level for queued notifications. Defaults to 'normal'.
   * @returns {Promise<{ sent: number; failed: number; errors: Array<{ subscriptionId: string; error: Error }> } | string>}
   * Returns an object containing the number of messages sent, failed, and errors, or the queue ID if using queue.
   */
  public async sendNotificationToTopics({
    topics,
    message,
    instanceIds,
    options,
    useQueue = false,
    priority = 'normal',
  }: {
    topics: Topic[]
    message: PushNotification
    instanceIds?: string[]
    options?: PushNotificationOptions
    useQueue?: boolean
    priority?: 'low' | 'normal' | 'high'
  }): Promise<
    | {
        sent: number
        failed: number
        errors: Array<{ subscriptionId: string; error: Error }>
      }
    | string
  > {
    // If using queue, add to queue and return the queue ID
    if (useQueue) {
      return this.queueNotification({
        topics,
        message,
        instanceIds,
        options,
        priority,
      })
    }
    const results = {
      sent: 0,
      failed: 0,
      errors: [] as Array<{ subscriptionId: string; error: Error }>,
    }
    // Get all subscription IDs for the specified topics
    const targetSubscriptions = new Set<string>()
    for (const topic of topics) {
      const topicSubs = this.topicSubscriptions.get(topic)
      if (topicSubs) {
        for (const subscriptionId of topicSubs) {
          targetSubscriptions.add(subscriptionId)
        }
      }
    }
    // Filter by user IDs if specified
    if (instanceIds && instanceIds.length > 0) {
      const filteredSubscriptions = new Set<string>()
      for (const subscriptionId of targetSubscriptions) {
        const subscription = this.subscriptions.get(subscriptionId)
        if (subscription && instanceIds.includes(subscription.instanceId)) {
          filteredSubscriptions.add(subscriptionId)
        }
      }
      targetSubscriptions.clear()
      for (const id of filteredSubscriptions) {
        targetSubscriptions.add(id)
      }
    }
    // Send messages using promise-based execution for optimal performance
    const sendPromises = Array.from(targetSubscriptions).map(
      async subscriptionId => {
        const subscription = this.subscriptions.get(subscriptionId)
        if (!subscription || !subscription.isActive) {
          return
        }

        try {
          await this.sendNotification(subscription, message, options)
          results.sent++
          subscription.lastUsed = new Date()
        } catch (error) {
          results.failed++
          results.errors.push({ subscriptionId, error })

          // If it's a 410 (Gone) or 404 (Not Found) error, mark subscription as inactive
          if (error.statusCode === 410 || error.statusCode === 404) {
            subscription.isActive = false
          }
        }
      },
    )
    await Promise.allSettled(sendPromises)
    return results
  }
  /**
   * Sends a push message to a specific user.
   *
   * @param {string} instanceId The unique identifier of the user to send the message to.
   * @param {PushNotification} message The message to send.
   * @param {PushNotificationOptions} [options] Optional. Additional options for the message.
   * @param {boolean} [useQueue] Optional. If true, adds the notification to the queue instead of sending immediately. Defaults to false.
   * @param {'low' | 'normal' | 'high'} [priority] Optional. Priority level for queued notifications. Defaults to 'normal'.
   * @returns {Promise<string>} Returns the subscription ID or queue ID if using queue.
   */
  public async sendNotificationToInstance({
    instanceId,
    message,
    options,
    useQueue = false,
    priority = 'normal',
  }: {
    instanceId: string
    message: PushNotification
    options?: PushNotificationOptions
    useQueue?: boolean
    priority?: 'low' | 'normal' | 'high'
  }): Promise<SendResult> {
    // If using queue, we need to find the topics this instance is subscribed to
    /* if (useQueue) {
      const subscriptionId = this.instanceSubscriptions.get(instanceId)
      if (!subscriptionId) {
        throw new Error(`No subscription found for instance: ${instanceId}`)
      }

      // Find all topics this instance is subscribed to
      const topics: Topic[] = []
      for (const [topic, topicSubs] of this.topicSubscriptions) {
        if (topicSubs.has(subscriptionId)) {
          topics.push(topic as Topic)
        }
      }

      if (topics.length === 0) {
        throw new Error(
          `Instance ${instanceId} is not subscribed to any topics`,
        )
      }

      return this.queueNotification({
        topics,
        message,
        instanceIds: [instanceId],
        options,
        priority,
      })
    } */
    const subscriptionId = this.instanceSubscriptions.get(instanceId)
    const subscription = this.subscriptions.get(subscriptionId)
    if (!subscription || !subscription.isActive) {
      return undefined
    }
    /* const instanceSubs = this.instanceSubscriptions.get(instanceId)
    if (!instanceSubs) {
      return undefined
    } */

    /* const results = {
      sent: 0,
      failed: 0,
      errors: [] as Array<{ subscriptionId: string; error: Error }>,
    } */

    // Send messages using promise-based execution for optimal performance
    /* const promises: (() => Promise<void>)[] = []
    for (const subscriptionId of instanceSubs) {
      promises.push(async () => {
        const subscription = this.subscriptions.get(subscriptionId)
        if (!subscription || !subscription.isActive) {
          return
        }

        try {
          await this.sendNotification(subscription, message, options)
          results.sent++
          subscription.lastUsed = new Date()
        } catch (error) {
          results.failed++
          results.errors.push({ subscriptionId, error })

          if (error.statusCode === 410 || error.statusCode === 404) {
            subscription.isActive = false
          }
        }
      })
    } */

    //await Promise.allSettled(promises)
    return await this.sendNotification(subscription, message, options)
  }
  /**
   * Gets subscription statistics.
   *
   * @returns {Promise<SubscriptionStats>} Returns an object containing the total number of subscriptions, active subscriptions, and subscriptions by topic and user.
   */
  public async getStats(): Promise<SubscriptionStats> {
    const stats: SubscriptionStats = {
      totalSubscriptions: this.subscriptions.size,
      activeSubscriptions: 0,
      subscriptionsByTopic: {},
      subscriptionsByInstance: {},
    }

    // Use async iteration for large collections to alleviate event loop pressure
    const subscriptions =
      this.subscriptions.size > 1000
        ? toAsyncIterable(this.subscriptions.values())
        : this.subscriptions.values()

    // count the subscriptions
    for await (const subscription of subscriptions) {
      if (subscription.isActive) stats.activeSubscriptions++

      // Count by topic
      /* for (const topic of subscription.topics) {
        stats.subscriptionsByTopic[topic] =
          (stats.subscriptionsByTopic[topic] || 0) + 1
      } */

      // Count by user
      stats.subscriptionsByInstance[subscription.instanceId] =
        (stats.subscriptionsByInstance[subscription.instanceId] || 0) + 1
    }

    return stats
  }
  /**
   * Gets all subscriptions for a topic.
   *
   * @param {string} topic The topic to get subscriptions for.
   * @returns {WebPushSubscription[]} Returns an array of subscriptions for the topic.
   */
  public getTopicSubscriptions(topic: string): PushSubscription[] {
    const topicSubs = this.topicSubscriptions.get(topic)
    if (!topicSubs) {
      return []
    }

    const subscriptions: PushSubscription[] = []
    for (const subscriptionId of topicSubs) {
      if (this.subscriptions.has(subscriptionId)) {
        subscriptions.push(this.subscriptions.get(subscriptionId)!)
      }
    }
    return subscriptions
  }
  /**
   * Checks if an instance is subscribed to a topic.
   *
   * @param instanceId The unique identifier of the instance to check
   * @param topic The topic to check
   * @returns Returns true if the instance is subscribed to the topic, false otherwise
   */
  private isInstanceSubscribedToTopic(
    instanceId: string,
    topic: Topic,
  ): boolean {
    const subscriptionId = this.instanceSubscriptions.get(instanceId)
    return (
      subscriptionId && this.topicSubscriptions.get(topic)?.has(subscriptionId)
    )
  }
  /**
   * Extends the expiry of a subscription.
   *
   * @param {string} subscriptionId The unique identifier of the subscription to extend.
   * @param {number} days The number of days to extend the subscription by.
   * @returns {boolean} Returns true if the subscription was extended successfully, false otherwise.
   */
  private extendSubscription(subscriptionId: string, days: number): boolean {
    const subscription = this.subscriptions.get(subscriptionId)
    if (!subscription) {
      return false
    }

    const newExpiry = new Date(Date.now() + days * 24 * 60 * 60 * 1000)
    subscription.expiresAt = newExpiry
    subscription.lastUsed = new Date()

    return true
  }
  /**
   * Cleans up expired subscriptions.
   *
   * @returns {Promise<number>} Returns the number of expired subscriptions removed.
   */
  private async cleanupExpiredSubscriptions(): Promise<number> {
    const now = new Date()
    const expiredIds: string[] = []

    // Use async iteration for large collections to alleviate event loop pressure
    const subscriptions =
      this.subscriptions.size > 1000
        ? toAsyncIterable(this.subscriptions)
        : this.subscriptions

    for await (const [id, subscription] of subscriptions) {
      if (subscription.expiresAt && subscription.expiresAt < now) {
        expiredIds.push(id)
      }
    }

    // Remove expired subscriptions - synchronous since it's fast
    for (const id of expiredIds) {
      this.removeSubscription(id)
    }

    return expiredIds.length
  }
  /**
   * Gets the VAPID public key for client configuration.
   *
   * @returns {string} Returns the VAPID public key.
   */
  private getVapidPublicKey(): string {
    return this.vapidConfig.publicKey
  }
  /**
   * Updates the VAPID configuration.
   *
   * @param {VapidConfig} vapidConfig The new VAPID configuration.
   */
  private updateVapidConfig(vapidConfig: VapidConfig): void {
    this.vapidConfig = vapidConfig
    setVapidDetails(
      vapidConfig.subject,
      vapidConfig.publicKey,
      vapidConfig.privateKey,
    )
  }
  /**
   * Sends a push message to a subscription.
   *
   * @param {WebPushSubscription} subscription The subscription to send the message to.
   * @param {PushNotification} message The message to send.
   * @param {PushNotificationOptions} [options] Optional. Additional options for the message.
   * @returns {Promise<void>} Returns a promise that resolves when the message is sent.
   */
  private async sendNotification(
    subscription: PushSubscription,
    message: PushNotification,
    options?: PushNotificationOptions,
  ): Promise<SendResult> {
    const payload = JSON.stringify({
      ...message,
      timestamp: message.timestamp || Date.now(),
    })

    return await sendNotification(
      {
        endpoint: subscription.endpoint.url,
        keys: subscription.endpoint.keys,
      },
      payload,
      options,
    )
  }
  /**
   * Removes a subscription.
   *
   * @param {string} subscriptionId The unique identifier of the subscription to remove.
   * @returns {void} Returns nothing.
   */
  private removeSubscription(subscriptionId: string): void {
    const subscription = this.subscriptions.get(subscriptionId)
    if (!subscription) return

    // Remove from topic index
    for (const [topic, topicSubs] of this.topicSubscriptions) {
      if (topicSubs.has(subscriptionId)) {
        topicSubs.delete(subscriptionId)
        if (topicSubs.size === 0) this.topicSubscriptions.delete(topic)
      }
    }

    // Remove from instance index
    this.instanceSubscriptions.delete(subscription.instanceId)

    // Remove from main subscriptions map
    this.subscriptions.delete(subscriptionId)
  }
  /**
   * Starts the cleanup interval.
   *
   * @returns {void} Returns nothing.
   */
  private startCleanupInterval(): void {
    this.cleanupInterval = setInterval(async () => {
      try {
        const cleaned = await this.cleanupExpiredSubscriptions()
        if (cleaned > 0) {
          log([
            ['push', 'cleanup'],
            ['action', 'cleanupExpiredSubscriptions'],
            ['cleaned', `${cleaned}`],
          ])
        }
      } catch (error) {
        log([
          ['push', 'cleanup'],
          ['action', 'cleanupExpiredSubscriptions'],
          ['status', 'error'],
          ['error', error.message],
        ])
      }
    }, this.CLEANUP_INTERVAL_MS)
  }

  /**
   * Adds a notification to the queue for batched processing.
   *
   * @param {Omit<QueuedNotification, 'id' | 'createdAt'>} notificationData The notification data to queue.
   * @returns {string} The unique ID of the queued notification.
   */
  public queueNotification(
    notificationData: Omit<QueuedNotification, 'id' | 'createdAt'>,
  ): string {
    const id = randomUUID()
    const queuedNotification: QueuedNotification = {
      ...notificationData,
      id,
      createdAt: new Date(),
    }
    this.notificationQueue.set(id, queuedNotification)
    return id
  }

  /**
   * Processes all queued notifications and sends them to subscribers.
   * Similar to how the indexer processes the profileQueue.
   *
   * @returns {Promise<{ processed: number; sent: number; failed: number; errors: Array<{ notificationId: string; error: Error }> }>}
   * Returns statistics about the processing operation.
   */
  public async processNotificationQueue(): Promise<{
    processed: number
    sent: number
    failed: number
    errors: Array<{ notificationId: string; error: Error }>
  }> {
    const results = {
      processed: 0,
      sent: 0,
      failed: 0,
      errors: [] as Array<{ notificationId: string; error: Error }>,
    }

    if (this.notificationQueue.size === 0) {
      return results
    }

    // Sort notifications by priority (high -> normal -> low) and then by creation time
    const sortedNotifications = Array.from(
      this.notificationQueue.values(),
    ).sort((a, b) => {
      const priorityOrder = { high: 3, normal: 2, low: 1 }
      const aPriority = priorityOrder[a.priority || 'normal']
      const bPriority = priorityOrder[b.priority || 'normal']

      if (aPriority !== bPriority) {
        return bPriority - aPriority // Higher priority first
      }

      return a.createdAt.getTime() - b.createdAt.getTime() // Earlier first for same priority
    })

    // Process notifications in parallel for better performance
    const processPromises = sortedNotifications.map(async notification => {
      try {
        const sendResults = await this.sendNotificationToTopics({
          topics: notification.topics,
          message: notification.message,
          instanceIds: notification.instanceIds,
          options: notification.options,
          useQueue: false, // Always send immediately when processing the queue
        })

        // sendResults is guaranteed to be the result object since useQueue is false
        const typedResults = sendResults as {
          sent: number
          failed: number
          errors: Array<{ subscriptionId: string; error: Error }>
        }

        results.sent += typedResults.sent
        results.failed += typedResults.failed
        results.errors.push(
          ...typedResults.errors.map(error => ({
            notificationId: notification.id,
            error: error.error,
          })),
        )

        results.processed++
      } catch (error) {
        results.failed++
        results.errors.push({
          notificationId: notification.id,
          error: error as Error,
        })
        results.processed++
      }
    })

    await Promise.allSettled(processPromises)

    // Clear the queue after processing
    this.clearNotificationQueue()

    return results
  }

  /**
   * Clears all queued notifications without processing them.
   *
   * @returns {number} The number of notifications that were cleared.
   */
  public clearNotificationQueue(): number {
    const size = this.notificationQueue.size
    this.notificationQueue.clear()
    return size
  }

  /**
   * Gets the current size of the notification queue.
   *
   * @returns {number} The number of notifications currently in the queue.
   */
  public getNotificationQueueSize(): number {
    return this.notificationQueue.size
  }

  /**
   * Gets a copy of all queued notifications (for debugging/monitoring purposes).
   *
   * @returns {QueuedNotification[]} Array of all queued notifications.
   */
  public getQueuedNotifications(): QueuedNotification[] {
    return Array.from(this.notificationQueue.values())
  }

  /**
   * Removes a specific notification from the queue by ID.
   *
   * @param {string} notificationId The ID of the notification to remove.
   * @returns {boolean} True if the notification was found and removed, false otherwise.
   */
  public removeQueuedNotification(notificationId: string): boolean {
    return this.notificationQueue.delete(notificationId)
  }

  /**
   * Convenience method to queue a notification and immediately process the queue.
   * Useful for modules that want to send notifications right away but still benefit from batching.
   *
   * @param {Omit<QueuedNotification, 'id' | 'createdAt'>} notificationData The notification data to queue and process.
   * @returns {Promise<{ processed: number; sent: number; failed: number; errors: Array<{ notificationId: string; error: Error }> }>}
   * Returns statistics about the processing operation.
   */
  public async queueAndProcessNotification(
    notificationData: Omit<QueuedNotification, 'id' | 'createdAt'>,
  ): Promise<{
    processed: number
    sent: number
    failed: number
    errors: Array<{ notificationId: string; error: Error }>
  }> {
    const queueId = this.queueNotification(notificationData)
    const results = await this.processNotificationQueue()
    return results
  }
}
