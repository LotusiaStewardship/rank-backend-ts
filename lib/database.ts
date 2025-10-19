/* eslint-disable no-unsafe-finally */
import {
  PrismaClient,
  type Profile as PrismaProfile,
  type Post as PrismaPost,
  type RankComment as PrismaRNKC,
  type RankTransaction as PrismaRANK,
} from '../prisma/prisma-client-js'
import { randomUUID } from 'crypto'
import { toAsyncIterable, toCommentUTF8 } from 'lotus-lib'
import {
  PushSubscription,
  PushSubscriptionPayload,
  TopicSubscription,
} from './push'
import {
  API_STATS_RESULT_COUNT,
  API_SEARCH_RESULT_COUNT,
  API_WALLET_RESULT_COUNT,
  ERR,
} from '../util/constants'
import type { Outpoint } from './indexer'
import type {
  ProfileMap,
  Block,
  Post,
  TargetEntity,
  ScriptChunkPlatformUTF8,
  ScriptChunkSentimentUTF8,
  Transaction,
  TransactionRANK,
  TransactionRNKC,
} from 'lotus-lib'

export type IndexedTransactionRANK = Transaction & PrismaRANK
export type IndexedTransactionRNKC = Transaction &
  PrismaRNKC & {
    post: PrismaPost & {
      profile: PrismaProfile | TargetEntityMetrics
    }
  }
/** Indexed transaction RANK, modified for `application/json` API response */
export type IndexedTransactionRANKAPI = IndexedTransactionRANK & {
  sats: string
  firstSeen: string
  timestamp: string | null
}
/** Indexed transaction RNKC, modified for `application/json` API response */
export type IndexedTransactionRNKCAPI = IndexedTransactionRNKC & {
  sats: string
  firstSeen: string
  timestamp: string | null
}
/** */
export type Voter = {
  /** ID of the voter is the 20-byte P2PKH */
  voterId: string
  ranking: string
  satsPositive: string
  satsNegative: string
  votesPositive: number
  votesNegative: number
  votesNeutral: number
}
/** Voter activity, modified for `application/json` API response */
export type VoterActivityAPI = {
  timestamp: string
  sats: string
  sentiment: ScriptChunkSentimentUTF8
  scriptPayload: string
  profileId: string
  postId: string
}
/** Voter activity summary, used in Temporal workflow execution */
export type VoterActivitySummary = {
  scriptPayload: string
  totalVotes: number
  /** Total number of sats burned during `Timespan` */
  totalSats: string
  lastSeen: string
  firstSeen: string
}
/** Metadata about the post's voter, included in authorized API responses */
export type VoterPostMetadata = {
  hasWalletUpvoted: boolean
  hasWalletDownvoted: boolean
  satsUpvoted: string
  satsDownvoted: string
  txidsUpvoted: string[]
  txidsDownvoted: string[]
}
/** Metadata about the profile's voter, included in authorized API responses */
export type VoterProfileMetadata = {
  hasWalletUpvoted: boolean
  hasWalletDownvoted: boolean
}
/** Indexed profile data, modified for `application/json` API response */
type ProfileAPI = TargetEntityMetricsAPI & {
  id: string
  platform: ScriptChunkPlatformUTF8
  /** RANK transactions associated with the profile */
  ranks?: IndexedTransactionRANK[]
  /** Comments associated with the profile */
  comments?: PostAPI[]
  voters?: [string, Voter][]
  profileMeta?: VoterProfileMetadata
}
/** Indexed post data, modified for `application/json` API response */
type PostAPI = TargetEntityMetricsAPI & {
  id: string
  platform: ScriptChunkPlatformUTF8
  profileId: string
  profile: TargetEntityMetricsAPI & {
    profileMeta?: VoterProfileMetadata
  }
  data?: string
  inReplyToPlatform?: ScriptChunkPlatformUTF8
  inReplyToProfileId?: string
  inReplyToPostId?: string
  firstSeen?: string
  timestamp?: string
  /** RANK transactions associated with the post */
  ranks?: IndexedTransactionRANK[]
  /** Comments associated with the post, modified for `application/json` API response */
  comments?: PostAPI[]
  /** Metadata about the post's voter, included in authorized API responses */
  postMeta?: VoterPostMetadata
}
/** Parameters for querying a post from API */
type PostQueryParameters = {
  profileId: string
  postId: string
}
/** Entity (e.g. profile, post) ranking metrics */
type TargetEntityMetrics = Pick<
  TargetEntity,
  | 'ranking'
  | 'satsPositive'
  | 'satsNegative'
  | 'votesPositive'
  | 'votesNegative'
>
/** Entity (e.g. profile, post) ranking metrics, modified for `application/json` API response */
type TargetEntityMetricsAPI = {
  ranking: string
  satsPositive: string
  satsNegative: string
  votesPositive: number
  votesNegative: number
}
export type Timespan =
  | 'now'
  | 'today'
  | 'day'
  | 'week'
  | 'month'
  | 'quarter'
  | 'all'
const targetEntityMetricsSelect = {
  ranking: true,
  satsPositive: true,
  satsNegative: true,
  votesPositive: true,
  votesNegative: true,
}
/**
 * Get the 00:00 UTC unix timestamp for the previous `Timespan`, in seconds
 * @param timespan `day`, `week`, etc.
 * @returns {number} the UTC unix timestamp beginning the `Timespan`, in seconds
 */
export const getTimestampUTC = (timespan: Timespan): number => {
  const now = new Date(Date.now())
  const today = Math.floor(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) / 1_000,
  )
  switch (timespan) {
    case 'now':
      return Math.floor(
        Date.UTC(
          now.getUTCFullYear(),
          now.getUTCMonth(),
          now.getUTCDate(),
          now.getUTCHours(),
          now.getUTCMinutes(),
          now.getUTCSeconds(),
        ) / 1_000,
      )
    case 'today':
      return today
    case 'day':
      return today - 86_400
    case 'week':
      return today - 604_800
    case 'month':
      return today - 2_592_000
    case 'quarter':
      return today - 7_776_000
    case 'all':
      return 0
  }
}

export class Database {
  private db: PrismaClient

  /**
   * Creates a new Database instance with the specified datasource URL
   * @param datasourceUrl The URL for the Prisma database connection
   */
  constructor(datasourceUrl: string) {
    this.db = new PrismaClient({
      errorFormat: 'minimal',
      datasourceUrl,
    })
  }

  /**
   * Establishes a connection to the database
   * @throws {Array} Throws an array containing error code and message if connection fails
   */
  async connect() {
    try {
      await this.db.$connect()
    } catch (e) {
      throw [ERR.IDX_DATABASE_CONNECT, e.message]
    }
  }

  /**
   * Closes the connection to the database
   */
  async disconnect() {
    await this.db.$disconnect()
  }
  /**
   * Saves a push subscription for an extension instance in the database.
   * Marks the instance as subscribed and creates a new subscription record.
   *
   * Some scalar fields, such as `createdAt`, have default values set, so they
   * are not included in the upsert operation.
   *
   * @param {PushSubscription} subscription - The push subscription object to save.
   *   - id: The unique identifier for the subscription.
   *   - instanceId: The ID of the extension instance.
   *   - endpoint: The push endpoint details (url, keys).
   *   - isActive: Whether the subscription is currently active.
   */
  async upsertPushSubscription(subscription: PushSubscription) {
    try {
      return await this.db.extensionPushSubscription.upsert({
        where: {
          instanceId: subscription.instanceId,
        },
        create: {
          id: subscription.id,
          //instanceId: subscription.instanceId,
          endpoint: subscription.endpoint.url,
          p256dhKey: subscription.endpoint.keys.p256dh,
          authKey: subscription.endpoint.keys.auth,
          isActive: subscription.isActive,
          instance: {
            connect: {
              id: subscription.instanceId,
            },
          },
        },
        update: {
          id: subscription.id,
          endpoint: subscription.endpoint.url,
          p256dhKey: subscription.endpoint.keys.p256dh,
          authKey: subscription.endpoint.keys.auth,
          isActive: subscription.isActive,
        },
      })
    } catch (e) {
      throw new Error(`db.upsertPushSubscription: ${e.message}`)
    }
  }
  /**
   * Saves a topic subscription for an extension instance in the database.
   * Updates the topic subscription record with the provided subscription details.
   *
   * @param {TopicSubscription} subscription - The topic subscription object to save.
   *   - id: The unique identifier for the topic subscription.
   *   - instanceId: The ID of the extension instance.
   *   - topic: The topic to which the instance is subscribing.
   */
  async upsertTopicSubscription(subscription: TopicSubscription) {
    try {
      await this.db.extensionTopicSubscription.upsert({
        where: {
          instanceId_topic: {
            instanceId: subscription.instanceId,
            topic: subscription.topic,
          },
        },
        create: {
          instanceId: subscription.instanceId,
          topic: subscription.topic,
          isActive: subscription.isActive,
          createdAt: subscription.createdAt,
          lastUsed: subscription.lastUsed,
        },
        update: {
          isActive: subscription.isActive,
          lastUsed: subscription.lastUsed,
        },
      })
    } catch (e) {
      throw new Error(`db.upsertTopicSubscription: ${e.message}`)
    }
  }
  /**
   * Retrieves all active push subscriptions from the database, including their
   * associated topic subscriptions.
   *
   * @returns A promise that resolves to an array of active push subscription records,
   * each including the related instance's topic subscriptions.
   */
  async getPushSubscriptions() {
    try {
      return await this.db.extensionPushSubscription.findMany({
        where: {
          isActive: true,
        },
        include: {
          instance: {
            select: {
              topicSubscriptions: true,
            },
          },
        },
      })
    } catch (e) {
      throw new Error(`db.getPushSubscriptions: ${e.message}`)
    }
  }
  /**
   * Deletes a push subscription from the database.
   * @param subscriptionId The ID of the subscription to delete.
   * @returns A promise that resolves to the deleted subscription.
   */
  async deletePushSubscription(subscriptionId: string) {
    try {
      return await this.db.extensionPushSubscription.delete({
        where: { id: subscriptionId },
      })
    } catch (e) {
      throw new Error(`db.deletePushSubscription: ${e.message}`)
    }
  }
  /**
   * Retrieves detailed activity data for a specific script payload within a given time range.
   * @param {object} params - The parameters for the query.
   * @param {string} params.scriptPayload - The script payload to filter activity by.
   * @param {Timespan} [params.startTime] - The start time for the activity range (optional).
   * @param {Timespan} [params.endTime] - The end time for the activity range (optional).
   * @param {'ipc' | 'api'} [requestType='ipc'] - The type of request, determines the response format.
   */
  async ipcGetScriptPayloadActivity(
    {
      scriptPayload,
      startTime,
      endTime,
    }: {
      scriptPayload: string
      startTime?: Timespan
      endTime?: Timespan
    },
    requestType: 'ipc' | 'api' = 'ipc',
  ): Promise<IndexedTransactionRANKAPI[] | IndexedTransactionRANK[]> {
    if (!startTime) {
      startTime = 'day'
    }
    if (!endTime) {
      endTime = 'today'
    }
    return await this.db.$transaction(async tx => {
      const results = await tx.rankTransaction.findMany({
        where: {
          timestamp: {
            gte: getTimestampUTC(startTime),
            lte: getTimestampUTC(endTime),
          },
          scriptPayload,
        },
        orderBy: {
          timestamp: 'desc',
        },
      })
      switch (requestType) {
        case 'api':
          return results.map(result => ({
            ...result,
            firstSeen: new Date(
              Number(result.timestamp * 1_000n),
            ).toISOString(),
            sats: result.sats.toString(),
            timestamp: result.timestamp.toString(),
          })) as IndexedTransactionRANKAPI[]
        case 'ipc':
          return results.map(result => ({
            firstSeen: new Date(
              Number(result.timestamp * 1_000n),
            ).toISOString(),
            ...result,
          })) as IndexedTransactionRANK[]
      }
    })
  }
  /**
   * Retrieves a summary of activity for all script payloads within a given time range
   * @param startTime - Optional start time for the query period
   * @param endTime - Optional end time for the query period
   * @returns Promise resolving to an array of ScriptPayloadActivity objects
   */
  async ipcGetScriptPayloadActivitySummary({
    scriptPayload,
    startTime,
    endTime,
  }: {
    scriptPayload?: string
    startTime?: Timespan
    endTime?: Timespan
  }): Promise<VoterActivitySummary[]> {
    if (!startTime) {
      startTime = 'day'
    }
    if (!endTime) {
      endTime = 'today'
    }
    try {
      const group = await this.db.rankTransaction.groupBy({
        by: ['scriptPayload'],
        where: {
          timestamp: {
            gte: getTimestampUTC(startTime),
            lte: getTimestampUTC(endTime),
          },
          // filter by script payload if provided
          // if undefined, return all script payloads
          scriptPayload,
        },
        _max: {
          timestamp: true,
        },
        _min: {
          timestamp: true,
        },
        _count: true,
        _sum: {
          sats: true,
        },
      })
      return group.map(
        ({ scriptPayload, _count, _sum, _max, _min }) =>
          ({
            scriptPayload,
            totalVotes: _count,
            totalSats: _sum.sats.toString(),
            lastSeen: new Date(Number(_max.timestamp * 1_000n)).toISOString(),
            firstSeen: new Date(Number(_min.timestamp * 1_000n)).toISOString(),
          }) as VoterActivitySummary,
      )
    } catch (e) {
      throw new Error(`db.ipcGetScriptPayloadActivitySummary: ${e.message}`)
    }
  }
  /**
   * Registers a new extension instance in the database
   * @param data Object containing extension data including id, scriptPayload, createdAt, and lastSeen
   * @returns Object with error field (null if successful, error message if failed)
   */
  async registerExtension(data: {
    id: string
    scriptPayload: string
    createdAt: Date
    lastSeen: Date
  }) {
    try {
      await this.db.extensionInstance.upsert({
        where: {
          id_scriptPayload: {
            id: data.id,
            scriptPayload: data.scriptPayload,
          },
        },
        create: {
          id: data.id,
          scriptPayload: data.scriptPayload,
          createdAt: data.createdAt,
          lastSeen: data.lastSeen,
        },
        update: {
          lastSeen: new Date(),
          // update scriptPayload as the auth header may be updated as well
          scriptPayload: data.scriptPayload,
          //createdAt: data.createdAt,
        },
      })
      return { error: null }
    } catch (e) {
      return { error: JSON.stringify(e.message) }
    }
  }
  /**
   * Retrieves wallet activity summary for the specified timespan
   * @param timespan - The timespan to retrieve data for
   * @returns Object containing total votes of both types, total unique wallets
   * voted, and total sats burned
   */
  async apiChartWalletSummary(startTime: Timespan, endTime?: Timespan) {
    if (
      !startTime ||
      (startTime !== 'day' &&
        startTime !== 'week' &&
        startTime !== 'month' &&
        startTime !== 'quarter')
    ) {
      startTime = 'day'
    }
    if (!endTime) {
      endTime = 'today'
    }
    const data = {
      totalVotes: 0,
      totalUpvotes: 0,
      totalDownvotes: 0,
      totalUniqueWallets: 0,
      totalSatsBurned: 0,
    }
    return await this.db.$transaction(async tx => {
      const upvotes = await tx.rankTransaction.groupBy({
        by: ['scriptPayload'],
        where: {
          sentiment: 'positive',
          timestamp: {
            gte: getTimestampUTC(startTime),
            lte: getTimestampUTC(endTime),
          },
          AND: [{ profileId: { not: 'null' } }, { postId: { not: 'null' } }],
        },
        _count: {
          sentiment: true,
        },
        _sum: {
          sats: true,
        },
      })
      const downvotes = await tx.rankTransaction.groupBy({
        by: ['scriptPayload'],
        where: {
          sentiment: 'negative',
          timestamp: {
            gte: getTimestampUTC(startTime),
            lte: getTimestampUTC(endTime),
          },
          AND: [{ profileId: { not: 'null' } }, { postId: { not: 'null' } }],
        },
        _count: {
          sentiment: true,
        },
        _sum: {
          sats: true,
        },
      })
      data.totalUniqueWallets = new Set(
        Array.from(upvotes.map(vote => vote.scriptPayload)).concat(
          Array.from(downvotes.map(vote => vote.scriptPayload)),
        ),
      ).size
      data.totalUpvotes = upvotes.reduce(
        (acc, curr) => acc + curr._count.sentiment,
        0,
      )
      data.totalDownvotes = downvotes.reduce(
        (acc, curr) => acc + curr._count.sentiment,
        0,
      )
      data.totalVotes = data.totalUpvotes + data.totalDownvotes
      data.totalSatsBurned =
        upvotes.reduce((acc, curr) => acc + Number(curr._sum.sats), 0) +
        downvotes.reduce((acc, curr) => acc + Number(curr._sum.sats), 0)

      return data
    })
  }
  /**
   * Searches for profiles on any platform
   * @param query - The query string to search for
   * @returns An array of profiles matching the query
   */
  async apiSearchProfile(query: string): Promise<ProfileAPI[]> {
    // execute the transaction, properly structuring the results
    return await this.db.$transaction(async tx => {
      const profiles = await tx.profile.findMany({
        select: {
          platform: true,
          id: true,
          ranking: true,
          satsPositive: true,
          satsNegative: true,
          votesPositive: true,
          votesNegative: true,
        },
        where: {
          OR: [
            {
              id: {
                startsWith: query,
                mode: 'insensitive',
              },
            },
            {
              id: {
                contains: query,
                mode: 'insensitive',
              },
            },
          ],
        },
        take: API_SEARCH_RESULT_COUNT,
      })
      return profiles.map(profile => ({
        id: profile.id,
        platform: profile.platform as ScriptChunkPlatformUTF8,
        ranking: profile.ranking.toString(),
        satsPositive: profile.satsPositive.toString(),
        satsNegative: profile.satsNegative.toString(),
        votesPositive: profile.votesPositive,
        votesNegative: profile.votesNegative,
      }))
    })
  }
  /**
   * Retrieves profile information for a specific platform and profile ID
   * @param platform The platform identifier (ScriptChunkPlatformUTF8)
   * @param profileId The unique identifier of the profile
   * @returns Profile data including ranking and vote statistics
   */
  async apiGetPlatformProfile(
    platform: ScriptChunkPlatformUTF8,
    profileId: string,
    includeVoters: boolean = true,
  ) {
    const data: ProfileAPI = {
      platform,
      id: profileId,
      ranking: '0',
      satsPositive: '0',
      satsNegative: '0',
      votesPositive: 0,
      votesNegative: 0,
      comments: null,
      voters: null,
    }
    return await this.db.$transaction(async tx => {
      try {
        const profile = await tx.profile.findUniqueOrThrow({
          where: {
            platform_id: { platform, id: profileId },
          },
          include: {
            comments: {
              include: {
                post: {
                  include: {
                    profile: {
                      select: targetEntityMetricsSelect,
                    },
                  },
                },
                /* post: {
                  select: {
                    ranking: true,
                    satsPositive: true,
                    satsNegative: true,
                    votesPositive: true,
                    votesNegative: true,
                  },
                }, */
              },
            },
          },
        })
        // Add indexed post data to return data
        data.ranking = profile.ranking.toString()
        data.satsPositive = profile.satsPositive.toString()
        data.satsNegative = profile.satsNegative.toString()
        data.votesPositive = profile.votesPositive
        data.votesNegative = profile.votesNegative
        // add the comments to the return data, or empty array if no comments
        if (profile.comments) {
          data.comments = []
          const profileCommentsIterable = toAsyncIterable(profile.comments)
          for await (const comment of profileCommentsIterable) {
            data.comments.push(this.convertRankCommentToPostAPI(comment))
          }
        }
        // get the voter details for the profile if specified
        if (includeVoters) {
          data.voters = await this.getProfileVoterDetails(
            tx as PrismaClient,
            profileId,
          )
        }
      } catch (e) {
        // nothing to do here
      } finally {
        // always return data, even if default profile data
        return data
      }
    })
  }
  /**
   * Retrieves post information for a specific platform, profile, and post ID
   * @param platform The platform identifier (ScriptChunkPlatformUTF8)
   * @param profileId The unique identifier of the profile
   * @param postId The unique identifier of the post
   * @param scriptPayload Optional script payload to filter ranks
   * @returns Post data including profile info, ranking, and vote statistics
   */
  async apiGetPlatformProfilePost(
    platform: ScriptChunkPlatformUTF8,
    profileId: string,
    postId: string,
    scriptPayload?: string,
  ) {
    const data: PostAPI =
      platform === 'lotusia'
        ? // Lotusia posts are indexed differently, so we need to handle them differently
          {
            id: postId,
            platform,
            profileId,
            data: '',
            inReplyToPlatform: null,
            inReplyToProfileId: null,
            inReplyToPostId: null,
            timestamp: null,
            ranking: '0',
            satsPositive: '0',
            satsNegative: '0',
            votesPositive: 0,
            votesNegative: 0,
            postMeta: null,
            profile: {
              profileMeta: null,
              ranking: '0',
              satsPositive: '0',
              satsNegative: '0',
              votesPositive: 0,
              votesNegative: 0,
            },
          }
        : // Other platforms are indexed the same, so we can use the same data structure
          {
            id: postId,
            platform,
            profileId,
            ranking: '0',
            satsPositive: '0',
            satsNegative: '0',
            votesPositive: 0,
            votesNegative: 0,
            postMeta: null,
            profile: {
              profileMeta: null,
              ranking: '0',
              satsPositive: '0',
              satsNegative: '0',
              votesPositive: 0,
              votesNegative: 0,
            },
          }
    const includeRanks = !scriptPayload
      ? undefined
      : {
          where: { scriptPayload, sentiment: { not: 'neutral' } },
          select: {
            txid: true,
            sats: true,
            sentiment: true,
          },
        }
    const checkWalletDownvotedProfile = !scriptPayload
      ? undefined
      : {
          // we only need to check if the wallet has downvoted the profile once
          take: 1,
          where: { scriptPayload, sentiment: 'negative' },
          select: {
            txid: true,
            sats: true,
            sentiment: true,
          },
        }
    return await this.db.$transaction(async tx => {
      try {
        const post = await tx.post.findUniqueOrThrow({
          where: {
            platform_profileId_id: { platform, profileId, id: postId },
          },
          include: {
            // Get the rank statistics for the post author
            profile: {
              select: {
                ranking: true,
                satsPositive: true,
                satsNegative: true,
                votesPositive: true,
                votesNegative: true,
                ranks: checkWalletDownvotedProfile,
              },
            },
            // Get the RANK transactions for the post that were voted on by the wallet,
            // identified by the script payload
            ranks: includeRanks,
            // RNKC data for the post, if it exists
            comment: {
              select: {
                inReplyToPlatform: true,
                inReplyToProfileId: true,
                inReplyToPostId: true,
                timestamp: true,
                firstSeen: true,
              },
            },
            // Replies to the post, if any
            comments: {
              include: {
                post: {
                  include: {
                    ranks: includeRanks,
                    profile: {
                      select: targetEntityMetricsSelect,
                    },
                    // Nested replies to replies of the post
                    comments: {
                      include: {
                        post: {
                          include: {
                            ranks: includeRanks,
                            profile: {
                              select: targetEntityMetricsSelect,
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        })
        // Add indexed post data to return data
        data.ranking = post.ranking.toString()
        data.satsPositive = post.satsPositive.toString()
        data.satsNegative = post.satsNegative.toString()
        data.votesPositive = post.votesPositive
        data.votesNegative = post.votesNegative
        // if this is a Lotusia post, add the comment data to the return data
        // All RNKC fields will be available if the `data` relation is not null
        if (post.data) {
          const {
            data: postData,
            comment: {
              inReplyToPlatform,
              inReplyToProfileId,
              inReplyToPostId,
              timestamp,
              firstSeen,
            },
          } = post
          data.data = toCommentUTF8(postData)
          data.inReplyToPlatform = inReplyToPlatform as ScriptChunkPlatformUTF8
          data.inReplyToProfileId = inReplyToProfileId
          data.inReplyToPostId = inReplyToPostId
          // set the timestamp to the firstSeen if it's before the
          // block timestamp, otherwise set it to the block timestamp
          const firstSeenSeconds = firstSeen / 1_000n
          data.timestamp =
            firstSeenSeconds < timestamp
              ? firstSeenSeconds.toString()
              : timestamp.toString()
        }
        // if this post has replies, add them to the return data
        if (post.comments) {
          data.comments = []
          const postRepliesIterable = toAsyncIterable(post.comments)
          for await (const reply of postRepliesIterable) {
            data.comments.push(this.convertRankCommentToPostAPI(reply))
            // TODO: add nested replies to the return data
          }
        }
        // set up post metadata
        if (post.ranks?.length) {
          // convert the sats to strings for JSON serialization
          data.postMeta = await this.convertRankTransactionsToPostMeta(
            post.ranks,
          )
        }
        // add the profile data to the return data
        data.profile = {
          ranking: post.profile.ranking.toString(),
          satsPositive: post.profile.satsPositive.toString(),
          satsNegative: post.profile.satsNegative.toString(),
          votesPositive: post.profile.votesPositive,
          votesNegative: post.profile.votesNegative,
        }
        // set up profile metadata
        if (post.profile.ranks?.length) {
          const profileMeta = {
            hasWalletUpvoted: false,
            hasWalletDownvoted: false,
          }
          post.profile.ranks.forEach(rank => {
            switch (rank.sentiment) {
              case 'positive':
                profileMeta.hasWalletUpvoted = true
                break
              case 'negative':
                profileMeta.hasWalletDownvoted = true
                break
            }
          })
          data.profile.profileMeta = profileMeta
        }
      } catch (e) {
        // fetch the indexed profile if the post doesn't exist
        const profile = await tx.profile.findUniqueOrThrow({
          where: {
            platform_id: { platform, id: profileId },
          },
          select: {
            ranking: true,
            satsPositive: true,
            satsNegative: true,
            votesPositive: true,
            votesNegative: true,
            ranks: checkWalletDownvotedProfile,
          },
        })
        data.profile = {
          ranking: profile.ranking.toString(),
          satsPositive: profile.satsPositive.toString(),
          satsNegative: profile.satsNegative.toString(),
          votesPositive: profile.votesPositive,
          votesNegative: profile.votesNegative,
        }
        // set up profile metadata
        if (profile.ranks?.length) {
          const profileMeta = {
            hasWalletUpvoted: false,
            hasWalletDownvoted: false,
          }
          profile.ranks.forEach(rank => {
            switch (rank.sentiment) {
              case 'positive':
                profileMeta.hasWalletUpvoted = true
                break
              case 'negative':
                profileMeta.hasWalletDownvoted = true
                break
            }
          })
          data.profile.profileMeta = profileMeta
        }
      } finally {
        // always return data, even if default profile data
        return data
      }
    })
  }
  /**
   * Retrieves posts for a platform
   * @param platform The platform identifier (ScriptChunkPlatformUTF8)
   * @param postRequests An array of post requests, containing objects with `profileId` and `postId` properties
   * @returns An array of posts
   */
  async apiGetPlatformPosts(
    platform: ScriptChunkPlatformUTF8,
    scriptPayload: string,
    query: PostQueryParameters[],
  ) {
    const data = {
      platform,
      posts: [],
    }
    try {
      const posts = await this.db.post.findMany({
        where: {
          platform,
          OR: [
            ...query.map(post => ({
              id: post.postId,
              profileId: post.profileId,
            })),
          ],
        },
        include: {
          profile: {
            select: {
              ranking: true,
              satsPositive: true,
              satsNegative: true,
              votesPositive: true,
              votesNegative: true,
            },
          },
          ranks: !scriptPayload
            ? undefined
            : {
                where: { scriptPayload },
                select: {
                  txid: true,
                  sentiment: true,
                },
              },
        },
      })
      data.posts = posts.map(post => ({
        ...post,
        ranking: post.ranking.toString(),
        satsPositive: post.satsPositive.toString(),
        satsNegative: post.satsNegative.toString(),
        votesPositive: post.votesPositive,
        votesNegative: post.votesNegative,
        postMeta: null,
        profile: {
          ranking: post.profile.ranking.toString(),
          satsPositive: post.profile.satsPositive.toString(),
          satsNegative: post.profile.satsNegative.toString(),
          votesPositive: post.profile.votesPositive,
          votesNegative: post.profile.votesNegative,
        },
      }))
    } catch (e) {
      console.warn(e)
    } finally {
      return data
    }
  }
  /**
   * Retrieves profiles from the database
   * @param page The page number to retrieve
   * @param pageSize The number of profiles per page
   * @returns An object containing the profiles and the number of pages
   */
  async apiGetProfiles(page: number, pageSize: number) {
    if (!page) {
      page = 1
    }
    if (!pageSize) {
      pageSize = 10
    }
    if (page < 1) {
      page = 1
    }
    if (pageSize > 40) {
      pageSize = 40
    }
    try {
      return await this.db.$transaction(async tx => {
        const totalProfiles = await tx.profile.count()
        const profiles = await tx.profile.findMany({
          orderBy: {
            ranking: 'desc',
          },
          skip: (page - 1) * pageSize,
          take: pageSize,
          select: {
            id: true,
            platform: true,
            ranking: true,
            satsPositive: true,
            satsNegative: true,
            votesPositive: true,
            votesNegative: true,
          },
        })
        return {
          profiles: profiles.map(profile => ({
            id: profile.id,
            platform: profile.platform,
            ranking: profile.ranking.toString(),
            satsPositive: profile.satsPositive.toString(),
            satsNegative: profile.satsNegative.toString(),
            votesPositive: profile.votesPositive,
            votesNegative: profile.votesNegative,
          })),
          numPages: Math.ceil(totalProfiles / pageSize),
        }
      })
    } catch (e) {
      console.warn(e)
      return { profiles: [], numPages: 0 }
    }
  }
  /**
   * Retrieves `RankTransaction`s for a specific `platform` and `profileId`
   * @param platform The platform identifier (ScriptChunkPlatformUTF8)
   * @param profileId The unique identifier of the profile
   * @param page The page number to retrieve
   * @param pageSize The number of transactions per page
   * @returns Array of `RankTransaction`s
   */
  async apiGetPlatformProfileVotesTableData(
    platform: ScriptChunkPlatformUTF8,
    profileId: string,
    page?: number,
    pageSize?: number,
  ) {
    // Make sure parameters are set
    if (!page) {
      page = 1
    }
    if (!pageSize) {
      pageSize = 10
    }
    if (page < 1) {
      page = 1
    }
    if (pageSize > 40) {
      pageSize = 40
    }
    try {
      return await this.db.$transaction(async tx => {
        const totalRanks = await tx.rankTransaction.count({
          where: {
            platform,
            profileId,
          },
        })
        const ranks = await tx.rankTransaction.findMany({
          where: {
            platform,
            profileId,
          },
          orderBy: [
            {
              timestamp: 'desc',
            },
            {
              firstSeen: 'desc',
            },
          ],
          // convert page to 0-based index
          skip: (page - 1) * pageSize,
          take: pageSize,
          select: {
            txid: true,
            outIdx: true,
            sentiment: true,
            firstSeen: true,
            timestamp: true,
            sats: true,
            post: {
              select: {
                id: true,
                ranking: true,
              },
            },
          },
        })
        return {
          votes: ranks.map(rank => ({
            ...rank,
            firstSeen: (rank.firstSeen / 1_000n).toString(),
            timestamp: rank.timestamp?.toString(),
            sats: rank.sats.toString(),
            post: rank.post
              ? {
                  ...rank.post,
                  ranking: rank.post.ranking.toString(),
                }
              : undefined,
          })),
          numPages: Math.ceil(totalRanks / pageSize),
        }
      })
    } catch (e) {
      console.warn(e)
      return { votes: [], numPages: 0 }
    }
  }
  /**
   * Retrieves posts for a platform profile
   * @param platform The platform identifier (ScriptChunkPlatformUTF8)
   * @param profileId The unique identifier of the profile
   * @param page The page number to retrieve
   * @param pageSize The number of posts per page
   * @returns An array of posts, sorted by ranking in descending order
   */
  async apiGetPlatformProfilePosts(
    platform: ScriptChunkPlatformUTF8,
    profileId: string,
    page?: number,
    pageSize?: number,
  ) {
    if (!page) {
      page = 1
    }
    if (!pageSize) {
      pageSize = 10
    }
    if (page < 1) {
      page = 1
    }
    if (pageSize > 40) {
      pageSize = 40
    }
    try {
      return await this.db.$transaction(async tx => {
        const totalPosts = await tx.post.count({
          where: {
            platform,
            profileId,
          },
        })
        const posts = await tx.post.findMany({
          where: {
            platform,
            profileId,
          },
          orderBy: {
            ranking: 'desc',
          },
          skip: (page - 1) * pageSize,
          take: pageSize,
          select: {
            id: true,
            ranking: true,
            satsPositive: true,
            satsNegative: true,
            votesPositive: true,
            votesNegative: true,
          },
        })
        return {
          posts: posts.map(post => ({
            ...post,
            ranking: post.ranking.toString(),
            satsPositive: post.satsPositive.toString(),
            satsNegative: post.satsNegative.toString(),
          })),
          numPages: Math.ceil(totalPosts / pageSize),
        }
      })
    } catch (e) {
      console.warn(e)
      return { posts: [], numPages: 0 }
    }
  }
  /**
   * Retrieves vote activity
   * @param page The page number to retrieve
   * @param pageSize The number of votes per page
   * @returns An object containing the votes and the number of pages
   */
  async apiGetVoteActivity(page: number, pageSize: number) {
    if (!page) {
      page = 1
    }
    if (!pageSize) {
      pageSize = 10
    }
    if (page < 1) {
      page = 1
    }
    if (pageSize > 40) {
      pageSize = 40
    }
    try {
      return await this.db.$transaction(async tx => {
        const totalVotes = await tx.rankTransaction.count()
        const votes = await tx.rankTransaction.findMany({
          orderBy: [
            {
              timestamp: 'desc',
            },
            {
              firstSeen: 'desc',
            },
          ],
          skip: (page - 1) * pageSize,
          take: pageSize,
          select: {
            platform: true,
            profileId: true,
            postId: true,
            scriptPayload: true,
            txid: true,
            firstSeen: true,
            sentiment: true,
            timestamp: true,
            sats: true,
          },
        })
        return {
          votes: votes.map(vote => ({
            ...vote,
            firstSeen: (vote.firstSeen / 1_000n).toString(),
            timestamp: vote.timestamp?.toString(),
            sats: vote.sats.toString(),
          })),
          numPages: Math.ceil(totalVotes / pageSize),
        }
      })
    } catch (e) {
      console.warn(e)
      return { votes: [], numPages: 0 }
    }
  }
  /**
   * Retrieves ranked statistics for a specific platform
   * @param dataType - The type of data to rank ('profileId' or 'postId')
   * @param rankingType - The ranking order ('top' or 'lowest')
   * @param startTime - Optional start time for the query period
   * @param endTime - Optional end time for the query period
   * @param includeVotes - Optional flag to include vote details
   * @param pageNum - Optional page number for pagination
   * @returns Promise resolving to an array of ranked statistics
   */
  async getStatsPlatformRanked({
    dataType,
    rankingType,
    startTime,
    endTime,
    includeVotes,
    pageNum,
  }: {
    dataType: 'profileId' | 'postId'
    rankingType: 'top' | 'lowest'
    startTime?: Timespan
    endTime?: Timespan
    includeVotes?: boolean
    pageNum?: number
  }) {
    // set default argument values
    if (!startTime) {
      startTime = 'day'
    }
    if (!endTime) {
      switch (startTime) {
        case 'today':
          endTime = 'now'
          break

        default:
          endTime = 'today'
          break
      }
    }
    if (!includeVotes) {
      includeVotes = false
    }
    if (!pageNum) {
      pageNum = 0
    }
    // Set up database query parameters
    const groupBy: [typeof dataType, 'sentiment'] = [dataType, 'sentiment']
    // Get the timestamp according to the specified Timespan
    try {
      const ranksBySentiment = await this.db.rankTransaction.groupBy({
        by: groupBy,
        where: {
          timestamp: {
            gte: getTimestampUTC(startTime),
            lte: getTimestampUTC(endTime),
          },
          AND: [{ profileId: { not: 'null' } }, { postId: { not: 'null' } }],
        },
        _count: {
          sentiment: true,
        },
        _sum: {
          sats: true,
        },
      })
      // process the RANK txs and calculate changes over `Timespan`
      const dataChanges: Map<string, TargetEntityMetrics> = new Map()
      ranksBySentiment.forEach(rank => {
        const { _count, _sum, sentiment } = rank
        if (!dataChanges.has(rank[dataType])) {
          dataChanges.set(rank[dataType], {
            ranking: 0n,
            satsPositive: 0n,
            satsNegative: 0n,
            votesPositive: 0,
            votesNegative: 0,
          })
        }
        const data = dataChanges.get(rank[dataType])
        switch (sentiment as ScriptChunkSentimentUTF8) {
          case 'positive': {
            data.ranking += BigInt(_sum.sats)
            data.satsPositive += BigInt(_sum.sats)
            data.votesPositive += _count.sentiment
            break
          }
          case 'negative': {
            data.ranking -= BigInt(_sum.sats)
            data.satsNegative += BigInt(_sum.sats)
            data.votesNegative += _count.sentiment
            break
          }
        }
      })
      // sort the calculated rankings according to highest or lowest
      // splice API_STATS_RESULT_COUNT from the front of the array
      let changesSortedFiltered: Array<[string, TargetEntityMetrics]>
      switch (rankingType) {
        case 'top': {
          changesSortedFiltered = [...dataChanges.entries()]
            .sort(([, a], [, b]) => Number(b.ranking) - Number(a.ranking))
            .splice(0, API_STATS_RESULT_COUNT)
          break
        }
        case 'lowest': {
          changesSortedFiltered = [...dataChanges.entries()]
            .sort(([, a], [, b]) => Number(a.ranking) - Number(b.ranking))
            .splice(0, API_STATS_RESULT_COUNT)
        }
      }
      const dbTable = dataType == 'profileId' ? 'profile' : 'post'
      const includeRanksSelect = !includeVotes
        ? undefined
        : {
            select: {
              txid: true,
            },
            orderBy: {
              timestamp: 'desc' as const,
            },
            skip: pageNum ? 10 * pageNum : undefined,
            take: 10,
          }
      type Item = {
        platform: ScriptChunkPlatformUTF8
        ranks?: {
          txid: string
        }[]
      }
      type ProfileItem = Item &
        Awaited<ReturnType<typeof this.db.profile.findFirst>>
      type PostItem = Item & Awaited<ReturnType<typeof this.db.post.findFirst>>
      return (
        // Fetch current profile/post ranking data to calculate changes
        // in the API/UI (i.e. +69 upvotes today, 6.9K Lotus increase)
        (
          (await this.db.$transaction(
            changesSortedFiltered.map(([id, changes]) =>
              // @ts-expect-error we don't care if the call signatures match because we know that the same input data powers both queries
              this.db[dbTable].findFirst({
                where: {
                  id,
                },
                include: {
                  ranks: includeRanksSelect,
                },
              }),
            ),
          )) as (ProfileItem | PostItem)[]
        )
          .map(item => {
            const changes = dataChanges.get(item.id)
            const rankingCurrent = Number(item.ranking)
            const rankingPrevious = Number(item.ranking - changes.ranking)
            const rankingChangePercentage =
              ((rankingCurrent - rankingPrevious) / rankingPrevious) * 100
            const ids: { profileId: string; postId?: string } = {
              profileId: item.id,
            }
            if (dataType == 'postId') {
              ids.postId = item.id
              ids.profileId = (item as PostItem).profileId
            }
            return {
              platform: item.platform,
              ...ids,
              total: {
                ranking: item.ranking.toString(),
                satsPositive: item.satsPositive.toString(),
                satsNegative: item.satsNegative.toString(),
                votesPositive: item.votesPositive,
                votesNegative: item.votesNegative,
              },
              changed: {
                ranking: changes.ranking.toString(),
                rate: rankingChangePercentage.toLocaleString(undefined, {
                  minimumFractionDigits: 1,
                  maximumFractionDigits: 1,
                }),
                satsPositive: changes.satsPositive.toString(),
                satsNegative: changes.satsNegative.toString(),
                votesPositive: changes.votesPositive,
                votesNegative: changes.votesNegative,
              },
              votesTimespan: item.ranks?.map(rank => rank.txid) ?? null,
            }
          })
          .filter(item => {
            switch (rankingType) {
              case 'top': {
                return BigInt(item.changed.ranking) > 0n
              }
              case 'lowest': {
                return BigInt(item.changed.ranking) < 0n
              }
            }
          })
      )
    } catch (e) {
      throw new Error(`db.getStatsPlatformRanked: ${e.message}`)
    }
  }
  /**
   * Reverts profile data to a previous state by removing ranks and decrementing statistics
   * @param profiles Map of profiles to rewind
   * @throws {Error} If the rewind operation fails
   */
  async rewindProfiles(profiles: ProfileMap) {
    try {
      const statements = await this.toProfileRewindStatements(profiles)
      await this.db.$transaction(statements)
    } catch (e) {
      throw new Error(`rewindProfiles: ${e.message}`)
    }
  }
  /**
   * Creates or updates profiles with their associated ranks and statistics
   * @param profiles Map of profiles to upsert
   * @throws {Error} If the upsert operation fails
   */
  async upsertProfiles(profiles: ProfileMap) {
    try {
      const statements = await this.toProfileUpsertStatements(profiles)
      await this.db.$transaction(statements)
    } catch (e) {
      throw new Error(`upsertProfiles: ${e.message}`)
    }
  }
  /**
   * Retrieves all rank transactions for a specific block height
   * @param height The block height to query
   * @returns Array of RankTransaction objects
   * @throws {Error} If the query fails
   */
  async getRankTransactionsByHeight(
    height: number,
  ): Promise<TransactionRANK[]> {
    try {
      const result = await this.db.rankTransaction.findMany({
        where: { height },
      })
      return result as TransactionRANK[]
    } catch (e) {
      throw new Error(`getRankTransactionsByHeight: ${e.message}`)
    }
  }
  /**
   * Retrieves all rank comments for a specific block height
   * @param height The block height to query
   * @returns Array of RankComment objects
   * @throws {Error} If the query fails
   */
  async getRankCommentsByHeight(height: number): Promise<TransactionRNKC[]> {
    try {
      const result = await this.db.rankComment.findMany({
        where: { height },
      })
      return result as TransactionRNKC[]
    } catch (e) {
      throw new Error(`getRankCommentsByHeight: ${e.message}`)
    }
  }
  /**
   * Retrieves a block by its height
   * @param height The block height to query
   * @returns The block data or null if not found
   * @throws {Error} If the query fails
   */
  async getBlockByHeight(height: number) {
    try {
      return await this.db.block.findFirst({
        where: { height },
      })
    } catch (e) {
      throw new Error(`getBlockByHeight: ${e.message}`)
    }
  }
  /**
   * Deletes a block with the specified height from the database
   * @param height The block height to delete
   * @throws {Error} If the deletion fails
   */
  async deleteBlockByHeight(height: number) {
    try {
      await this.db.block.delete({
        where: { height },
      })
    } catch (e) {
      throw new Error(`deleteBlockByHeight: ${e.message}`)
    }
  }
  /**
   * Saves a new block with its associated LOKAD transactions and profiles
   * @param block The block data to save
   * @param outpoints Array of outpoints to connect to the block
   * @param profiles Map of profiles to upsert with the block
   * @throws {Error} If the save operation fails
   */
  async saveBlock(
    block: Block,
    outpoints: {
      ranks: Outpoint[]
      rnkcs: Outpoint[]
    },
    profiles: ProfileMap,
  ) {
    // Connect RANK txs to the block, since they were upserted from mempool
    const ranksConnect = outpoints.ranks.map(({ txid, outIdx }) => ({
      txid_outIdx: {
        txid,
        outIdx,
      },
    }))
    // Connect RNKC txs to the block, since they were upserted from mempool
    const commentsConnect = outpoints.rnkcs.map(({ txid }) => ({
      txid,
    }))
    try {
      await this.db.$transaction([
        // Create the block and connect corresponding RANK txs
        this.db.block.create({
          data: {
            ...block,
            ranks: {
              connect: ranksConnect,
            },
            comments: {
              connect: commentsConnect,
            },
          },
        }),
        // Upsert any profiles that were confirmed in the block but not already
        // upserted from the mempool
        // LOKAD txs upserted here will be connected to above block
        ...(await this.toProfileUpsertStatements(profiles)),
      ])
    } catch (e) {
      throw new Error(
        `saveBlock(${block.height}, ${outpoints.ranks.length}, ${outpoints.rnkcs.length}, ${profiles.size}): ${e.message}`,
      )
    }
  }
  /**
   * Saves multiple blocks and their associated profiles in a single transaction
   * @param blocks Array of blocks to save
   * @param profiles Map of profiles to upsert with the blocks
   * @throws {Error} If the save operation fails
   */
  async saveBlockRange(blocks: Block[], profiles: ProfileMap) {
    try {
      await this.db.$transaction([
        // Create all of the blocks first for `height` pkey
        this.db.block.createMany({ data: blocks }),
        // Upsert all profiles
        // These RANK txs are automatically connected to their block by height
        ...(await this.toProfileUpsertStatements(profiles)),
      ])
    } catch (e) {
      throw new Error(
        `saveBlockRange(${blocks.length} blocks, ${profiles.size} profiles): ${e.message}`,
      )
    }
  }
  /**
   * Get the best `Block` from the database (i.e. highest `height`)
   * @returns {Promise<Block>} The best `Block` as checkpoint
   */
  async getCheckpoint(): Promise<Block> {
    try {
      return await this.db.block.findFirst({
        orderBy: { height: 'desc' },
        select: {
          hash: true,
          height: true,
          timestamp: true,
          ranksLength: true,
          rnkcsLength: true,
        },
      })
    } catch (e) {
      throw new Error(`getCheckpoint: ${e.message}`)
    }
  }
  /**
   * Generates database statements for upserting push subscriptions
   * @param subscriptions Map of push subscriptions to generate upsert statements for
   * @returns Array of database upsert statements
   */
  async toSubscriptionUpsertStatements(
    subscriptions: Map<string, PushSubscription>,
  ) {
    const upserts: ReturnType<
      typeof this.db.extensionPushSubscription.upsert
    >[] = []
    for await (const [id, subscription] of toAsyncIterable(subscriptions)) {
      upserts.push(
        this.db.extensionPushSubscription.upsert({
          where: { instanceId: subscription.instanceId },
          create: {
            id: subscription.id,
            instanceId: subscription.instanceId,
            endpoint: subscription.endpoint.url,
            p256dhKey: subscription.endpoint.keys.p256dh,
            authKey: subscription.endpoint.keys.auth,
            isActive: subscription.isActive,
          },
          update: {
            endpoint: subscription.endpoint.url,
            p256dhKey: subscription.endpoint.keys.p256dh,
            authKey: subscription.endpoint.keys.auth,
            isActive: subscription.isActive,
          },
        }),
      )
    }
    return upserts
  }
  /**
   * Generates database statements for upserting profiles and their associated posts
   * @param profiles - Map of profiles to generate upsert statements for
   * @returns Array of database upsert statements
   */
  async toProfileUpsertStatements(profiles: ProfileMap) {
    const upserts: ReturnType<
      typeof this.db.post.upsert | typeof this.db.profile.upsert
    >[] = []
    const profilesIterable = toAsyncIterable(profiles)
    for await (const [id, profile] of profilesIterable) {
      const {
        platform,
        ranks,
        comments,
        ranking,
        satsPositive,
        satsNegative,
        votesPositive,
        votesNegative,
      } = profile
      const ranksCreateMany = ranks
        ? {
            createMany: {
              data: ranks,
            },
          }
        : undefined
      const commentsCreateMany = comments
        ? {
            createMany: {
              data: comments,
            },
          }
        : undefined
      // push profile upsert first
      // These upserts will create the RankTransaction records
      upserts.push(
        this.db.profile.upsert({
          where: {
            platform_id: { platform, id },
          },
          // profile doesn't exist
          create: {
            id,
            platform,
            ranking,
            satsPositive,
            satsNegative,
            votesPositive,
            votesNegative,
            account: { create: { id: randomUUID() } },
            ranks: ranksCreateMany,
            comments: commentsCreateMany,
          },
          // profile exists
          update: {
            ranks: ranksCreateMany,
            comments: commentsCreateMany,
            ranking: {
              increment: ranking,
            },
            satsPositive: {
              increment: satsPositive,
            },
            satsNegative: {
              increment: satsNegative,
            },
            votesPositive: {
              increment: votesPositive,
            },
            votesNegative: {
              increment: votesNegative,
            },
          },
        }),
      )
      // push any post upsert(s) after Profile exists
      // These upserts will connect the RankTransaction records to the Post
      if (profile.posts) {
        const posts = toAsyncIterable(profile.posts)
        for await (const [id, post] of posts) {
          const {
            platform,
            profileId,
            data, // data is the comment text for Lotusia posts
            ranking,
            satsPositive,
            satsNegative,
            votesPositive,
            votesNegative,
            ranks,
            comments,
          } = post
          const ranksConnect = ranks
            ? {
                connect: ranks.map(rank => ({
                  txid_outIdx: {
                    txid: rank.txid,
                    outIdx: rank.outIdx,
                  },
                })),
              }
            : undefined
          // We don't want to connect comments here, because comments are not
          // necessarily associated with the profile. If comments are defined
          // in this post, then we want to create the comment record(s) in the
          // upsert statement(s) below
          const commentsConnectOrCreate = comments
            ? {
                connectOrCreate: comments.map(comment => ({
                  where: {
                    txid: comment.txid,
                  },
                  create: comment,
                })),
              }
            : undefined
          const increments = {
            ranking: {
              increment: ranking,
            },
            satsPositive: {
              increment: satsPositive,
            },
            satsNegative: {
              increment: satsNegative,
            },
            votesPositive: {
              increment: votesPositive,
            },
            votesNegative: {
              increment: votesNegative,
            },
          }
          // upsert the post first
          upserts.push(
            this.db.post.upsert({
              where: {
                platform_profileId_id: {
                  platform,
                  profileId,
                  id,
                },
              },
              // post doesn't exist
              create: {
                id,
                platform,
                profileId,
                data, // data is the comment text for Lotusia posts
                ranking,
                satsPositive,
                satsNegative,
                votesPositive,
                votesNegative,
                ranks: ranksConnect,
                comments: commentsConnectOrCreate,
              },
              // post exists
              update: {
                ranks: ranksConnect,
                comments: commentsConnectOrCreate,
                ...increments,
              },
            }),
          )
        }
      }
    }
    return upserts
  }
  /**
   * Generates database statements for rewinding profiles and their associated posts
   * @param profiles - Map of profiles to generate rewind statements for
   * @returns Array of database update statements for rewinding
   */
  async toProfileRewindStatements(profiles: ProfileMap) {
    const rewinds: ReturnType<
      typeof this.db.post.update | typeof this.db.profile.update
    >[] = []
    const profilesIterable = toAsyncIterable(profiles)
    for await (const [id, profile] of profilesIterable) {
      const {
        platform,
        ranks,
        comments,
        ranking,
        satsPositive,
        satsNegative,
        votesPositive,
        votesNegative,
      } = profile
      const ranksDelete = ranks
        ? {
            deleteMany: {
              txid: {
                in: ranks.map(rank => rank.txid),
              },
            },
          }
        : undefined
      const commentsDelete = comments
        ? {
            deleteMany: {
              txid: {
                in: comments.map(comment => comment.txid),
              },
            },
          }
        : undefined
      // push profile rewind first
      rewinds.push(
        this.db.profile.update({
          where: {
            platform_id: { platform, id },
          },
          data: {
            ranks: ranksDelete,
            comments: commentsDelete,
            ranking: {
              decrement: ranking,
            },
            satsPositive: {
              decrement: satsPositive,
            },
            satsNegative: {
              decrement: satsNegative,
            },
            votesPositive: {
              decrement: votesPositive,
            },
            votesNegative: {
              decrement: votesNegative,
            },
          },
        }),
      )
      // push any post rewind(s) after
      if (profile.posts) {
        for (const [id, post] of profile.posts) {
          const {
            platform,
            profileId,
            ranks,
            comments,
            ranking,
            satsPositive,
            satsNegative,
            votesPositive,
            votesNegative,
          } = post
          const ranksDelete = ranks
            ? {
                deleteMany: {
                  txid: {
                    in: ranks.map(rank => rank.txid),
                  },
                },
              }
            : undefined
          const commentsDelete = comments
            ? {
                deleteMany: {
                  txid: {
                    in: comments.map(comment => comment.txid),
                  },
                },
              }
            : undefined
          const decrements = {
            ranking: {
              decrement: ranking,
            },
            satsPositive: {
              decrement: satsPositive,
            },
            satsNegative: {
              decrement: satsNegative,
            },
            votesPositive: {
              decrement: votesPositive,
            },
            votesNegative: {
              decrement: votesNegative,
            },
          }
          rewinds.push(
            this.db.post.update({
              where: {
                platform_profileId_id: {
                  platform,
                  profileId,
                  id,
                },
              },
              data: {
                ranks: ranksDelete,
                comments: commentsDelete,
                // decrement post counters
                ...decrements,
              },
            }),
          )
        }
      }
    }
    return rewinds
  }
  /**
   * Retrieves voter details for a specific platform profile
   * @param tx - The Prisma client transaction
   * @param platform - The platform identifier (ScriptChunkPlatformUTF8)
   * @param profileId - The unique identifier of the profile
   * @returns Object containing voter details for the profile
   */
  private async getProfileVoterDetails(tx: PrismaClient, profileId: string) {
    const voters = await tx.rankTransaction.groupBy({
      by: ['scriptPayload', 'sentiment'],
      where: {
        profileId,
        AND: [{ profileId: { not: 'null' } }],
      },
      // How many votes total
      // TODO: get total upvotes and downvotes
      _count: {
        sentiment: true,
      },
      _sum: {
        sats: true,
      },
    })
    const voterDetails: Record<string, Voter> = {}
    voters.forEach(details => {
      let voter = voterDetails[details.scriptPayload]
      if (!voter) {
        voter = {
          voterId: details.scriptPayload,
          satsPositive: '0',
          satsNegative: '0',
          votesPositive: 0,
          votesNegative: 0,
          votesNeutral: 0,
          ranking: '0',
        }
      }

      const ranking = BigInt(voter.ranking)
      switch (details.sentiment) {
        case 'positive':
          voter.votesPositive += details._count.sentiment
          voter.ranking = (ranking + details._sum.sats).toString()
          break
        case 'negative':
          voter.votesNegative += details._count.sentiment
          voter.ranking = (ranking - details._sum.sats).toString()
          break
        case 'neutral':
          voter.votesNeutral += details._count.sentiment
          break
      }

      voterDetails[details.scriptPayload] = voter
    })

    return Object.entries(voterDetails)
  }
  /**
   * Converts a TransactionRNKC to a PostAPI
   * @param rnkc - The TransactionRNKC to convert
   * @returns The PostAPI
   */
  private convertRankCommentToPostAPI(rnkc: IndexedTransactionRNKC): PostAPI {
    return {
      id: rnkc.txid,
      platform: rnkc.post.platform as ScriptChunkPlatformUTF8,
      profileId: rnkc.post.profileId,
      data: toCommentUTF8(rnkc.data),
      inReplyToPlatform: rnkc.inReplyToPlatform as ScriptChunkPlatformUTF8,
      inReplyToProfileId: rnkc.inReplyToProfileId,
      inReplyToPostId: rnkc.inReplyToPostId,
      firstSeen: (rnkc.firstSeen / 1_000n).toString(),
      timestamp: rnkc.timestamp.toString(),
      ranking: rnkc.post.ranking.toString(),
      satsPositive: rnkc.post.satsPositive.toString(),
      satsNegative: rnkc.post.satsNegative.toString(),
      votesPositive: rnkc.post.votesPositive,
      votesNegative: rnkc.post.votesNegative,
      profile: {
        ranking: rnkc.post.profile.ranking.toString(),
        satsPositive: rnkc.post.profile.satsPositive.toString(),
        satsNegative: rnkc.post.profile.satsNegative.toString(),
        votesPositive: rnkc.post.profile.votesPositive,
        votesNegative: rnkc.post.profile.votesNegative,
      },
    }
  }
  /**
   * Converts a list of rank transactions to a PostMeta
   * @param ranks - The list of rank transactions to convert
   * @returns The `VoterPostMetadata` object
   */
  private async convertRankTransactionsToPostMeta(
    ranks: Partial<PrismaRANK>[],
  ): Promise<VoterPostMetadata> {
    let hasWalletUpvoted = false
    let hasWalletDownvoted = false
    let satsUpvoted = 0n
    let satsDownvoted = 0n
    const txidsUpvoted: string[] = []
    const txidsDownvoted: string[] = []
    const ranksIterable = toAsyncIterable(ranks)
    for await (const rank of ranksIterable) {
      switch (rank.sentiment) {
        case 'positive':
          hasWalletUpvoted = true
          txidsUpvoted.push(rank.txid)
          satsUpvoted += rank.sats
          break
        case 'negative':
          hasWalletDownvoted = true
          txidsDownvoted.push(rank.txid)
          satsDownvoted += rank.sats
          break
      }
    }
    return {
      hasWalletUpvoted,
      hasWalletDownvoted,
      satsUpvoted: satsUpvoted.toString(),
      satsDownvoted: satsDownvoted.toString(),
      txidsUpvoted,
      txidsDownvoted,
    }
  }
}
