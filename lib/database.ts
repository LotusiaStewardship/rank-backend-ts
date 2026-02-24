/* eslint-disable no-unsafe-finally */
import {
  PrismaClient,
  type Profile as PrismaProfile,
  type Post as PrismaPost,
  type RankComment as PrismaRNKC,
  type RankTransaction as PrismaRANK,
} from '../prisma/prisma-client-js'
import { randomUUID } from 'crypto'
import { type Block } from 'lotus-nng-client'
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
  FEED_RANKING_VELOCITY_WINDOW_HOURS,
  FEED_RANKING_CONTROVERSIAL_MIN_ENGAGEMENT,
} from '../util/constants'
import {
  computeCompositeFeedScore,
  applyZScoreCapping,
  computeVelocityDampening,
  computeControversySortScore,
} from '../util/feedRanking'
import type {
  Outpoint,
  Post,
  ProfileMap,
  IndexedTransaction,
  TargetEntity,
  TransactionRANK,
  TransactionRNKC,
} from './indexer'
import type {
  ScriptChunkPlatformUTF8,
  ScriptChunkSentimentUTF8,
} from 'xpi-ts/lib/rank'
import { toAsyncIterable } from '../util/functions'
import { BufferUtil } from 'xpi-ts/lib/bitcore'

export type IndexedTransactionRANK = IndexedTransaction & PrismaRANK
export type IndexedTransactionRNKC = IndexedTransaction &
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
  date: string // ISO-formatted timestampe
}
/** Indexed transaction RNKC, modified for `application/json` API response */
export type IndexedTransactionRNKCAPI = IndexedTransactionRNKC & {
  sats: string
  firstSeen: string
  timestamp: string | null
  date: string // ISO-formatted timestampe
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
/** Feed filter parameters for unified post feed queries */
export type FeedFilterParams = {
  platform?: ScriptChunkPlatformUTF8
  sortBy?: 'ranking' | 'curated' | 'recent' | 'controversial'
  startTime?: Timespan
  page?: number
  pageSize?: number
  scriptPayload?: string
}
/** Feed response with pagination metadata */
export type FeedResponse = {
  posts: PostAPI[]
  pagination: {
    page: number
    pageSize: number
    totalPages: number
    totalItems: number
    hasNext: boolean
    hasPrev: boolean
  }
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
  ranks?: Array<{
    txid: string
    sats: string
    sentiment: ScriptChunkSentimentUTF8
    firstSeen: string
    timestamp?: string // block timestamp, null if RANK tx is unconfirmed
  }>
  /** Comments associated with the profile */
  comments?: PostAPI[]
  voters?: Voter[]
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
  firstVoted: string
  lastVoted: string
  data?: string
  inReplyToPlatform?: ScriptChunkPlatformUTF8
  inReplyToProfileId?: string
  inReplyToPostId?: string
  firstSeen?: string
  timestamp?: string
  /** RANK transactions associated with the post */
  ranks?: Array<{
    txid: string
    sats: string
    sentiment: ScriptChunkSentimentUTF8
    firstSeen: string
    timestamp?: string // block timestamp, null if RANK tx is unconfirmed
  }>
  /** Comments associated with the post, modified for `application/json` API response */
  comments?: PostAPI[]
  /**
   * Ancestor chain for RNKC replies — ordered from genesis post (index 0) to
   * immediate parent (last index). Only populated when the post has inReplyToPostId set.
   * Enables Twitter-style "view full conversation" rendering on the detail page.
   */
  ancestors?: PostAPI[]
  /** Metadata about the post's voter, included in authorized API responses */
  postMeta?: VoterPostMetadata
  /**
   * Feed ranking signals (R62–R66). Present on feed responses; absent on
   * individual post lookups. All derived from aggregate burns only.
   */
  /** R62: Logarithmically dampened net feed score */
  feedScore?: number
  /** R63: Z-score-normalized feed score (capped at FEED_RANKING_ZSCORE_MAX) */
  feedScoreNormalized?: number
  /** R65: Fraction of total burns that are positive (0–1) */
  sentimentRatio?: number
  /** R65: How evenly contested the burns are (0 = one-sided, 1 = perfectly split) */
  controversyScore?: number
  /** R65: Log-dampened total of all burns (pos + neg), used as tiebreaker */
  totalEngagement?: number
  /** R65: Whether this post exceeds the controversy threshold */
  isControversial?: boolean
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
export const getTimestampUTC = (timespan: Timespan = 'month'): number => {
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
            date: new Date(Number(result.timestamp * 1_000n)).toISOString(),
            firstSeen: new Date(
              Number(result.firstSeen * 1_000n),
            ).toISOString(),
            sats: result.sats.toString(),
            timestamp: result.timestamp.toString(),
          })) as IndexedTransactionRANKAPI[]
        case 'ipc':
          return results.map(result => {
            return {
              ...result,
              date: new Date(Number(result.timestamp * 1_000n)).toISOString(),
            } as IndexedTransactionRANK
          })
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
    scriptPayload?: string,
    includeVoters: boolean = false,
  ) {
    const data: ProfileAPI = {
      platform,
      id: profileId,
      ranks: null,
      ranking: '0',
      satsPositive: '0',
      satsNegative: '0',
      votesPositive: 0,
      votesNegative: 0,
      profileMeta: null,
      comments: null,
    }
    return await this.db.$transaction(async tx => {
      try {
        const profile = await tx.profile.findUniqueOrThrow({
          where: {
            platform_id: { platform, id: profileId },
          },
          include: {
            ranks: scriptPayload !== undefined,
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
        // Add indexed profile data to return data
        Object.assign(data, this.serializeEntityMetrics(profile))
        // add the comments to the return data, or empty array if no comments
        if (profile.comments) {
          data.comments = []
          for (const comment of profile.comments) {
            data.comments.push(this.convertRankCommentToPostAPI(comment))
          }
        }
        // Add voter metadata; useful when client polls for profile directly
        if (profile.ranks) {
          data.profileMeta = this.buildProfileMetadata(profile.ranks)
          data.ranks = profile?.ranks.map(rank => ({
            txid: rank.txid,
            sats: rank.sats.toString(),
            sentiment: rank.sentiment as ScriptChunkSentimentUTF8,
            firstSeen: (rank.firstSeen / 1_000n).toString(),
            //timestamp: rank.timestamp.toString(),
          }))
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
            firstVoted: null,
            lastVoted: null,
            ranks: null,
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
            firstVoted: null,
            lastVoted: null,
            ranks: null,
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
    const includeRanks = this.buildIncludeRanksClause(scriptPayload)
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
        Object.assign(data, this.serializeEntityMetrics(post))
        // Add timestamps
        data.firstVoted = post.firstVoted?.toString() ?? null
        data.lastVoted = post.lastVoted?.toString() ?? null
        // if this is a Lotusia post, add the comment data to the return data
        // All RNKC fields will be available if the `data` relation is not null
        if (post.data && post.comment) {
          this.populateLotusiaPostFields(data, post.data, post.comment)
          // Fetch ancestor chain for Twitter-style "view full conversation" rendering.
          // Only populated when this post is a reply (inReplyToPostId is set).
          if (post.comment.inReplyToPostId) {
            data.ancestors = await this.fetchAncestorChain(
              tx as PrismaClient,
              post.comment.inReplyToPlatform,
              post.comment.inReplyToProfileId,
              post.comment.inReplyToPostId,
              20,
              scriptPayload,
            )
          }
        }
        // if this post has replies, add them to the return data
        if (post.comments) {
          data.comments = []
          const postRepliesIterable = toAsyncIterable(post.comments)
          for await (const reply of postRepliesIterable) {
            const replyAPI = this.convertRankCommentToPostAPI(reply)
            // Serialize level-2 nested replies (fetched by Prisma include above)
            if (reply.post.comments?.length) {
              replyAPI.comments = reply.post.comments.map(nested =>
                this.convertRankCommentToPostAPI(nested),
              )
            }
            data.comments.push(replyAPI)
          }
        }
        // set up post metadata and recent vote history (week or month)
        if (post.ranks?.length) {
          data.postMeta = await this.buildPostMeta(post.ranks)
          data.ranks = post.ranks.map(rank => ({
            txid: rank.txid,
            sats: rank.sats.toString(),
            sentiment: rank.sentiment as ScriptChunkSentimentUTF8,
            firstSeen: (rank.firstSeen / 1_000n).toString(),
            //timestamp: rank.timestamp.toString(),
          }))
        }
        // add the profile data to the return data
        data.profile = this.serializeEntityMetrics(post.profile)
        // set up profile metadata
        data.profile.profileMeta = this.buildProfileMetadata(post.profile.ranks)
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
        data.profile = this.serializeEntityMetrics(profile)
        data.profile.profileMeta = this.buildProfileMetadata(profile.ranks)
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
    ;({ page, pageSize } = this.normalizePaginationParams(page, pageSize))
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
    ;({ page, pageSize } = this.normalizePaginationParams(page, pageSize))
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
  async apiGetPlatformProfilePosts({
    platform,
    profileId,
    scriptPayload,
    page,
    pageSize,
  }: {
    platform: ScriptChunkPlatformUTF8
    profileId: string
    scriptPayload?: string
    page?: number
    pageSize?: number
  }) {
    ;({ page, pageSize } = this.normalizePaginationParams(page, pageSize))
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
            firstVoted: true,
            ranking: true,
            satsPositive: true,
            satsNegative: true,
            votesPositive: true,
            votesNegative: true,
            ranks: this.buildIncludeRanksClause(scriptPayload),
          },
        })
        const postsWithMeta = []
        for (const post of posts) {
          const postData = {
            id: post.id,
            firstVoted: post.firstVoted?.toString(),
            ranking: post.ranking.toString(),
            satsPositive: post.satsPositive.toString(),
            satsNegative: post.satsNegative.toString(),
            votesPositive: post.votesPositive,
            votesNegative: post.votesNegative,
          } as PostAPI

          // set up the postMeta property if the scriptPayload was provided
          // and this scriptPayload has voted on the posts
          if (post.ranks?.length) {
            postData.postMeta = await this.buildPostMeta(post.ranks)
          }
          postsWithMeta.push(postData)
        }
        return {
          posts: postsWithMeta,
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
    ;({ page, pageSize } = this.normalizePaginationParams(page, pageSize))
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
   *
   * Statements are structured in three phases to satisfy FK constraints:
   *   Phase 1: Upsert Profiles and Posts (parent records, no child relations)
   *   Phase 2: Create RankTransactions and RankComments (child records via Profile relation)
   *   Phase 3: Connect RankTransactions to Posts and connectOrCreate RankComments on Posts
   *
   * @param profiles - Map of profiles to generate upsert statements for
   * @returns Array of database upsert statements
   */
  async toProfileUpsertStatements(profiles: ProfileMap) {
    // Phase 1: Upsert parent records (Profiles and Posts) without child relations
    const phase1: ReturnType<
      typeof this.db.post.upsert | typeof this.db.profile.upsert
    >[] = []
    // Phase 2: Create child records (RankTransactions and RankComments) via Profile relation
    const phase2: ReturnType<typeof this.db.profile.update>[] = []
    // Phase 3: Connect RankTransactions to Posts and connectOrCreate RankComments on Posts
    const phase3: ReturnType<typeof this.db.post.update>[] = []
    for (const [id, profile] of profiles) {
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
      // Phase 1: Upsert the Profile without ranks or comments
      phase1.push(
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
          },
          // profile exists
          update: {
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
      // Phase 1: Upsert Posts without rank connections or comments
      if (profile.posts) {
        const posts = toAsyncIterable(profile.posts)
        for await (const [postId, post] of posts) {
          const {
            platform: postPlatform,
            profileId,
            data, // data is the comment text for Lotusia posts
            firstVoted: postTimestamp,
            lastVoted: postLastVoted,
            ranking: postRanking,
            satsPositive: postSatsPositive,
            satsNegative: postSatsNegative,
            votesPositive: postVotesPositive,
            votesNegative: postVotesNegative,
            ranks: postRanks,
            comments: postComments,
          } = post
          const postIncrements = {
            ranking: {
              increment: postRanking,
            },
            satsPositive: {
              increment: postSatsPositive,
            },
            satsNegative: {
              increment: postSatsNegative,
            },
            votesPositive: {
              increment: postVotesPositive,
            },
            votesNegative: {
              increment: postVotesNegative,
            },
          }
          phase1.push(
            this.db.post.upsert({
              where: {
                platform_profileId_id: {
                  platform: postPlatform,
                  profileId,
                  id: postId,
                },
              },
              // post doesn't exist
              create: {
                id: postId,
                platform: postPlatform,
                profileId,
                data, // data is the comment text for Lotusia posts
                firstVoted: postTimestamp,
                lastVoted: postLastVoted,
                ranking: postRanking,
                satsPositive: postSatsPositive,
                satsNegative: postSatsNegative,
                votesPositive: postVotesPositive,
                votesNegative: postVotesNegative,
              },
              // post exists: update lastVoted to the most recent tx timestamp in this batch
              // Include data in update so that Posts previously created by RANK txs
              // (with data: null) get their data set when the RNKC tx is processed,
              // satisfying the RankComment FK constraint [txid, scriptPayload, data]
              update: {
                ...postIncrements,
                ...(data !== undefined && { data }),
                lastVoted: postLastVoted,
              },
            }),
          )
          // Phase 3: Connect RankTransactions to Posts and connectOrCreate RankComments
          const ranksConnect = postRanks?.length
            ? {
                connect: postRanks.map(rank => ({
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
          const commentsConnectOrCreate = postComments?.length
            ? {
                connectOrCreate: postComments.map(comment => ({
                  where: {
                    txid_scriptPayload_data: {
                      txid: comment.txid,
                      scriptPayload: comment.scriptPayload,
                      data: comment.data,
                    },
                  },
                  create: comment,
                })),
              }
            : undefined
          if (ranksConnect || commentsConnectOrCreate) {
            phase3.push(
              this.db.post.update({
                where: {
                  platform_profileId_id: {
                    platform: postPlatform,
                    profileId,
                    id: postId,
                  },
                },
                data: {
                  ranks: ranksConnect,
                  comments: commentsConnectOrCreate,
                },
              }),
            )
          }
        }
      }
      // Phase 2: Create RankTransactions and RankComments via Profile relation
      const ranksCreateMany = ranks?.length
        ? {
            createMany: {
              data: ranks,
            },
          }
        : undefined
      const commentsCreateMany = comments?.length
        ? {
            createMany: {
              data: comments,
            },
          }
        : undefined
      if (ranksCreateMany || commentsCreateMany) {
        phase2.push(
          this.db.profile.update({
            where: {
              platform_id: { platform, id },
            },
            data: {
              ranks: ranksCreateMany,
              comments: commentsCreateMany,
            },
          }),
        )
      }
    }
    return [...phase1, ...phase2, ...phase3]
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
  // ─── Referral Methods ──────────────────────────────────────────────────

  /**
   * Creates a new referral code in the database
   * @param code - The HMAC-derived referral code (16-char hex)
   * @param referrerPayload - The scriptPayload of the referrer
   * @param expiresAt - The expiration date for the referral code
   * @returns The created ReferralCode record
   */
  async createReferralCode(
    code: string,
    referrerPayload: string,
    expiresAt: Date,
  ) {
    try {
      return await this.db.referralCode.create({
        data: {
          code,
          referrerPayload,
          expiresAt,
        },
      })
    } catch (e) {
      throw new Error(`db.createReferralCode: ${e.message}`)
    }
  }

  /**
   * Creates multiple referral codes in a single transaction (for genesis batch)
   * @param codes - Array of referral code data objects
   * @returns The count of created records
   */
  async createReferralCodeBatch(
    codes: Array<{
      code: string
      referrerPayload: string
      expiresAt: Date
    }>,
  ) {
    try {
      return await this.db.referralCode.createMany({
        data: codes,
      })
    } catch (e) {
      throw new Error(`db.createReferralCodeBatch: ${e.message}`)
    }
  }

  /**
   * Retrieves a referral code by its code string
   * @param code - The referral code to look up
   * @returns The ReferralCode record or null if not found
   */
  async getReferralCode(code: string) {
    try {
      return await this.db.referralCode.findUnique({
        where: { code },
      })
    } catch (e) {
      throw new Error(`db.getReferralCode: ${e.message}`)
    }
  }

  /**
   * Atomically redeems a referral code by setting the redeemer fields.
   * Uses a where clause to ensure the code has not already been redeemed.
   * @param code - The referral code to redeem
   * @param redeemerPayload - The scriptPayload of the redeemer
   * @param redeemerIp - The IP address of the redeemer
   * @returns The updated ReferralCode record
   */
  async redeemReferralCode(
    code: string,
    redeemerPayload: string,
    redeemerIp: string,
  ) {
    try {
      return await this.db.referralCode.update({
        where: {
          code,
          redeemedAt: null,
        },
        data: {
          redeemerPayload,
          redeemerIp,
          redeemedAt: new Date(),
        },
      })
    } catch (e) {
      throw new Error(`db.redeemReferralCode: ${e.message}`)
    }
  }

  /**
   * Counts outstanding (unredeemed, unexpired) referral codes for a referrer
   * @param referrerPayload - The scriptPayload of the referrer
   * @returns The count of outstanding referral codes
   */
  async countOutstandingReferralCodes(
    referrerPayload: string,
  ): Promise<number> {
    try {
      return await this.db.referralCode.count({
        where: {
          referrerPayload,
          redeemedAt: null,
          expiresAt: { gt: new Date() },
        },
      })
    } catch (e) {
      throw new Error(`db.countOutstandingReferralCodes: ${e.message}`)
    }
  }

  /**
   * Counts recent referral redemptions from a specific IP address within the last 24 hours
   * @param ip - The IP address to check
   * @returns The count of recent redemptions from this IP
   */
  async countRecentRedemptionsByIp(ip: string): Promise<number> {
    try {
      const oneDayAgo = new Date(Date.now() - 86_400_000)
      return await this.db.referralCode.count({
        where: {
          redeemerIp: ip,
          redeemedAt: { gte: oneDayAgo },
        },
      })
    } catch (e) {
      throw new Error(`db.countRecentRedemptionsByIp: ${e.message}`)
    }
  }

  // ─── Faucet Methods ───────────────────────────────────────────────────

  /**
   * Creates a new faucet claim record for a referred user
   * @param scriptPayload - The scriptPayload of the new user
   * @param referralCode - The referral code that was redeemed
   * @returns The created FaucetClaim record
   */
  async createFaucetClaim(scriptPayload: string, referralCode: string) {
    try {
      return await this.db.faucetClaim.create({
        data: {
          scriptPayload,
          referralCode,
        },
      })
    } catch (e) {
      throw new Error(`db.createFaucetClaim: ${e.message}`)
    }
  }

  /**
   * Retrieves a faucet claim by scriptPayload
   * @param scriptPayload - The scriptPayload to look up
   * @returns The FaucetClaim record or null if not found
   */
  async getFaucetClaim(scriptPayload: string) {
    try {
      return await this.db.faucetClaim.findUnique({
        where: { scriptPayload },
      })
    } catch (e) {
      throw new Error(`db.getFaucetClaim: ${e.message}`)
    }
  }

  /**
   * Advances a faucet claim to the next milestone and records the drip amount
   * @param scriptPayload - The scriptPayload of the user
   * @param nextMilestone - The new milestone number
   * @param dripAmount - The amount dripped in this milestone (in satoshis)
   * @returns The updated FaucetClaim record
   */
  async advanceFaucetMilestone(
    scriptPayload: string,
    nextMilestone: number,
    dripAmount: bigint,
  ) {
    try {
      return await this.db.faucetClaim.update({
        where: { scriptPayload },
        data: {
          milestone: nextMilestone,
          totalDripped: { increment: dripAmount },
          lastDripAt: new Date(),
        },
      })
    } catch (e) {
      throw new Error(`db.advanceFaucetMilestone: ${e.message}`)
    }
  }

  // ─── Engagement Methods ───────────────────────────────────────────────

  /**
   * Gets or creates a WalletEngagement record for a scriptPayload
   * @param scriptPayload - The scriptPayload to look up or create
   * @returns The WalletEngagement record
   */
  async getOrCreateWalletEngagement(scriptPayload: string) {
    try {
      return await this.db.walletEngagement.upsert({
        where: { scriptPayload },
        create: { scriptPayload },
        update: {},
      })
    } catch (e) {
      throw new Error(`db.getOrCreateWalletEngagement: ${e.message}`)
    }
  }

  /**
   * Updates a WalletEngagement record with new computed values
   * @param scriptPayload - The scriptPayload to update
   * @param data - The fields to update
   * @returns The updated WalletEngagement record
   */
  async updateWalletEngagement(
    scriptPayload: string,
    data: {
      tier?: number
      engagementPoints?: number
      epBreakdown?: object
      lifetimeVotes?: number
      lifetimeReferrals?: number
      lifetimeComments?: number
      currentStreak?: number
      longestStreak?: number
      lastVoteDate?: Date
      lifetimeRewards?: bigint
    },
  ) {
    try {
      return await this.db.walletEngagement.update({
        where: { scriptPayload },
        data,
      })
    } catch (e) {
      throw new Error(`db.updateWalletEngagement: ${e.message}`)
    }
  }

  /**
   * Upserts a WalletEngagement record — creates if not exists, updates if exists.
   * Used by the backfill script and daily EP recomputation.
   * @param scriptPayload - The scriptPayload to upsert
   * @param data - The engagement data to set
   * @returns The upserted WalletEngagement record
   */
  async upsertWalletEngagement(
    scriptPayload: string,
    data: {
      tier: number
      engagementPoints: number
      epBreakdown: object
      lifetimeVotes: number
      lifetimeReferrals: number
      lifetimeComments: number
      currentStreak: number
      longestStreak: number
      lastVoteDate: Date | null
      lifetimeRewards: bigint
    },
  ) {
    try {
      return await this.db.walletEngagement.upsert({
        where: { scriptPayload },
        create: { scriptPayload, ...data },
        update: data,
      })
    } catch (e) {
      throw new Error(`db.upsertWalletEngagement: ${e.message}`)
    }
  }

  /**
   * Resets streaks for wallets that haven't voted since the given date.
   * Called daily to break streaks for inactive users.
   * @param cutoffDate - Wallets with lastVoteDate before this are reset
   * @returns The count of updated records
   */
  async resetBrokenStreaks(cutoffDate: Date) {
    try {
      return await this.db.walletEngagement.updateMany({
        where: {
          currentStreak: { gt: 0 },
          lastVoteDate: { lt: cutoffDate },
        },
        data: {
          currentStreak: 0,
        },
      })
    } catch (e) {
      throw new Error(`db.resetBrokenStreaks: ${e.message}`)
    }
  }

  /**
   * Retrieves all distinct scriptPayloads that have cast RANK votes.
   * Used by the backfill script to enumerate all wallets.
   * @returns Array of distinct scriptPayload strings
   */
  async getDistinctVoterScriptPayloads(): Promise<string[]> {
    try {
      const results = await this.db.rankTransaction.groupBy({
        by: ['scriptPayload'],
      })
      return results.map(r => r.scriptPayload)
    } catch (e) {
      throw new Error(`db.getDistinctVoterScriptPayloads: ${e.message}`)
    }
  }

  /**
   * Counts the total number of RANK transactions for a specific scriptPayload
   * @param scriptPayload - The scriptPayload to count votes for
   * @returns The total vote count
   */
  async countRankTxsByScriptPayload(scriptPayload: string): Promise<number> {
    try {
      return await this.db.rankTransaction.count({
        where: { scriptPayload },
      })
    } catch (e) {
      throw new Error(`db.countRankTxsByScriptPayload: ${e.message}`)
    }
  }

  /**
   * Counts the number of redeemed referral codes where the given scriptPayload is the referrer
   * @param referrerPayload - The scriptPayload of the referrer
   * @returns The count of redeemed referrals
   */
  async countRedeemedReferralsByReferrer(
    referrerPayload: string,
  ): Promise<number> {
    try {
      return await this.db.referralCode.count({
        where: {
          referrerPayload,
          redeemedAt: { not: null },
        },
      })
    } catch (e) {
      throw new Error(`db.countRedeemedReferralsByReferrer: ${e.message}`)
    }
  }

  /**
   * Counts the number of RNKC comments posted by a specific scriptPayload
   * @param scriptPayload - The scriptPayload to count comments for
   * @returns The total comment count
   */
  async countRnkcCommentsByScriptPayload(
    scriptPayload: string,
  ): Promise<number> {
    try {
      return await this.db.rankComment.count({
        where: { scriptPayload },
      })
    } catch (e) {
      throw new Error(`db.countRnkcCommentsByScriptPayload: ${e.message}`)
    }
  }

  /**
   * Gets the total XPI burned by a scriptPayload across all RANK transactions
   * @param scriptPayload - The scriptPayload to sum burns for
   * @returns The total sats burned as bigint
   */
  async getTotalBurnedByScriptPayload(scriptPayload: string): Promise<bigint> {
    try {
      const result = await this.db.rankTransaction.aggregate({
        where: { scriptPayload },
        _sum: { sats: true },
      })
      return result._sum.sats ?? 0n
    } catch (e) {
      throw new Error(`db.getTotalBurnedByScriptPayload: ${e.message}`)
    }
  }

  /**
   * Gets the earliest RANK transaction timestamp for a scriptPayload (account age proxy)
   * @param scriptPayload - The scriptPayload to check
   * @returns The earliest timestamp as bigint, or null if no transactions
   */
  async getEarliestRankTimestamp(
    scriptPayload: string,
  ): Promise<bigint | null> {
    try {
      const result = await this.db.rankTransaction.aggregate({
        where: { scriptPayload },
        _min: { timestamp: true },
      })
      return result._min.timestamp ?? null
    } catch (e) {
      throw new Error(`db.getEarliestRankTimestamp: ${e.message}`)
    }
  }

  /**
   * Gets the most recent vote date for a scriptPayload
   * @param scriptPayload - The scriptPayload to check
   * @returns The most recent timestamp as bigint, or null if no transactions
   */
  async getLatestRankTimestamp(scriptPayload: string): Promise<bigint | null> {
    try {
      const result = await this.db.rankTransaction.aggregate({
        where: { scriptPayload },
        _max: { timestamp: true },
      })
      return result._max.timestamp ?? null
    } catch (e) {
      throw new Error(`db.getLatestRankTimestamp: ${e.message}`)
    }
  }

  /**
   * Counts distinct days on which a scriptPayload has voted, used for streak calculation.
   * Returns an array of distinct vote dates (UTC day boundaries).
   * @param scriptPayload - The scriptPayload to check
   * @returns Array of distinct vote date strings (YYYY-MM-DD)
   */
  async getDistinctVoteDates(scriptPayload: string): Promise<string[]> {
    try {
      const results: Array<{ vote_date: string }> = await this.db.$queryRaw`
        SELECT DISTINCT DATE(TO_TIMESTAMP("timestamp")) AS vote_date
        FROM "RankTransaction"
        WHERE "scriptPayload" = ${scriptPayload}
        AND "timestamp" IS NOT NULL
        ORDER BY vote_date DESC
      `
      return results.map(r => r.vote_date)
    } catch (e) {
      throw new Error(`db.getDistinctVoteDates: ${e.message}`)
    }
  }

  /**
   * Retrieves a paginated feed of posts with profile data, rankings, and comments.
   * This is the primary unified feed query — it fetches Post models directly and
   * includes their associated Profile metrics, RNKC comment metadata (for Lotusia
   * posts), and reply threads.
   *
   * Supports filtering by platform, sorting by ranking/curated/recency/controversy, and
   * optional wallet-specific vote metadata via scriptPayload.
   *
   * sortBy='curated' applies the full R62–R65 burn-only dampening pipeline:
   *   R62: aggregate logarithmic dampening (log₂(1+B_pos/BASE) - log₂(1+B_neg/BASE))
   *   R63: cross-content z-score capping (prevents feed monopoly)
   *   R65: bidirectional signal fields (sentimentRatio, controversyScore, isControversial)
   *
   * sortBy='controversial' applies the R65 burn-weighted controversy sort:
   *   controversySortScore = controversyScore × totalEngagement
   *   where controversyScore = min(B_pos, B_neg) / max(B_pos, B_neg)
   *   and   totalEngagement  = log₂(1 + (B_pos + B_neg) / BASE)
   *   Defaults to a 7-day window (same as 'curated') to surface currently contested
   *   content rather than historical artifacts.
   *
   * @param filters - Feed filter parameters (platform, sortBy, time range, pagination, scriptPayload)
   * @returns Feed response with PostAPI[] and pagination metadata
   */
  async apiGetFeedPosts(filters: FeedFilterParams = {}): Promise<FeedResponse> {
    const {
      platform,
      sortBy = 'curated',
      startTime,
      page = 1,
      pageSize = 20,
      scriptPayload,
    } = filters

    // For 'curated' and 'controversial' sorts, default to a 7-day window when no
    // startTime is given. This ensures recency bias: curated operates on content
    // with community signal within the past week; controversial surfaces content
    // that is *currently* generating contested signal, not historical artifacts.
    const effectiveStartTime: Timespan | undefined =
      startTime ??
      (sortBy === 'curated' || sortBy === 'controversial' ? 'week' : undefined)

    const normalizedPage = Math.max(1, page)
    const normalizedPageSize = Math.min(20, Math.max(1, pageSize))

    try {
      return await this.db.$transaction(async tx => {
        // Build where clause for Post model
        const whereClause: any = {}
        if (platform) {
          whereClause.platform = platform
        }
        // Time-based filtering: find posts that received at least one vote within
        // the timespan. Uses 'some' (not 'every') so a post qualifies if any of
        // its votes fall in the window — not all of them.
        // For Lotusia posts, also check RNKC comment timestamps (initial XPI burn)
        if (effectiveStartTime && effectiveStartTime !== 'all') {
          const timestampFilter = { gte: getTimestampUTC(effectiveStartTime) }
          whereClause.OR = [
            {
              ranks: {
                some: {
                  timestamp: timestampFilter,
                },
              },
            },
            {
              comment: {
                timestamp: timestampFilter,
              },
            },
          ]
        }

        // Build orderBy based on sort mode.
        // 'curated' fetches by linear ranking first, then re-sorts in-memory
        // after applying R62–R65 dampening (Prisma cannot order by relation fields).
        let orderBy: any
        switch (sortBy) {
          case 'recent':
            // Most recently voted-on posts first (by latest RANK tx)
            // Prisma doesn't support ordering by relation aggregates directly,
            // so we order by ranking desc as a proxy and filter by time
            orderBy = [{ lastVoted: 'desc' }]
            break
          case 'controversial':
            // Posts with significant burns on both sides. Filter on satsPositive
            // and satsNegative (burn-based, Sybil-neutral) rather than vote counts.
            // Fetch by total burns desc as a proxy; in-memory re-sort by
            // controversySortScore (controversyScore × totalEngagement) follows.
            whereClause.AND = [
              { satsPositive: { gt: 0n } },
              { satsNegative: { gt: 0n } },
            ]
            orderBy = [{ satsPositive: 'desc' }, { satsNegative: 'desc' }]
            break
          case 'curated':
          case 'ranking':
          default:
            orderBy = [{ ranking: 'desc' }]
            break
        }

        // Wallet-specific RANK vote filter (for Vote-to-Reveal postMeta)
        const includeRanks = this.buildIncludeRanksClause(scriptPayload)

        // For 'curated' and 'controversial' sorts, fetch a larger candidate set
        // so we can re-sort in-memory and then paginate.
        const isDampened = sortBy === 'curated'
        const isControversialSort = sortBy === 'controversial'
        const fetchSize =
          isDampened || isControversialSort
            ? Math.min(normalizedPageSize * 5, 200)
            : normalizedPageSize
        const fetchSkip =
          isDampened || isControversialSort
            ? 0
            : (normalizedPage - 1) * normalizedPageSize

        const [totalItems, posts] = await Promise.all([
          tx.post.count({ where: whereClause }),
          tx.post.findMany({
            where: whereClause,
            orderBy,
            skip: fetchSkip,
            take: fetchSize,
            include: {
              profile: {
                select: targetEntityMetricsSelect,
              },
              // RNKC data for Lotusia posts (comment metadata)
              comment: {
                select: {
                  inReplyToPlatform: true,
                  inReplyToProfileId: true,
                  inReplyToPostId: true,
                  timestamp: true,
                  firstSeen: true,
                },
              },
              // Replies to this post
              comments: {
                include: {
                  post: {
                    include: {
                      profile: {
                        select: targetEntityMetricsSelect,
                      },
                    },
                  },
                },
              },
              // Wallet-specific vote data (if scriptPayload provided)
              ranks: includeRanks,
            },
          }),
        ])

        const totalPages = Math.ceil(totalItems / normalizedPageSize)

        // Convert each post to PostAPI shape, computing R62/R65 signals
        const feedPosts: PostAPI[] = []
        for (const post of posts) {
          // R64: decay anchor depends on sort mode.
          // curated: firstVoted — prevents a trivial re-burn from resetting the
          //   decay clock on old content (e.g. 100 XPI reviving a 2-week-old spam post).
          // recent/other: lastVoted — re-emerging content with genuine new activity
          //   surfaces correctly.
          const decayAnchor = Number(post.firstVoted)

          // R62/R63/R64/R66: compute composite feed score for this post
          const signals = computeCompositeFeedScore(
            post.satsPositive,
            post.satsNegative,
            decayAnchor,
          )

          // Build PostAPI object with computed signals
          const postData: PostAPI = {
            id: post.id,
            platform: post.platform as ScriptChunkPlatformUTF8,
            profileId: post.profileId,
            firstVoted: post.firstVoted?.toString(),
            lastVoted: post.lastVoted?.toString(),
            ...this.serializeEntityMetrics(post),
            profile: this.serializeEntityMetrics(post.profile),
            // R62: logarithmically dampened net score
            feedScore: signals.feedScore,
            // R65: bidirectional signal fields
            sentimentRatio: signals.sentimentRatio,
            controversyScore: signals.controversyScore,
            totalEngagement: signals.totalEngagement,
            isControversial: signals.isControversial,
          }
          // Lotusia post: add RNKC comment data (text, inReplyTo, timestamps)
          if (post.data && post.comment) {
            this.populateLotusiaPostFields(postData, post.data, post.comment)
            // If this RNKC post is replying to another post, fetch that ancestor post
            // if it is available and add it to the return data.
            if (post.comment.inReplyToPostId) {
              postData.ancestors = await this.fetchAncestorChain(
                tx as PrismaClient,
                post.comment.inReplyToPlatform,
                post.comment.inReplyToProfileId,
                post.comment.inReplyToPostId,
                1,
                scriptPayload,
              )
            }
          }
          // Add reply threads (RNKC comments on this post)
          if (post.comments?.length) {
            postData.comments = []
            for (const reply of post.comments) {
              postData.comments.push(
                this.convertRankCommentToPostAPI(
                  reply as unknown as IndexedTransactionRNKC,
                ),
              )
            }
          }
          // Add wallet-specific vote metadata (Vote-to-Reveal R1)
          if (post.ranks?.length) {
            postData.postMeta = await this.buildPostMeta(post.ranks)
          }
          feedPosts.push(postData)
        }

        // R65: for 'controversial' sort, re-sort in-memory by controversySortScore
        // (controversyScore × totalEngagement) and paginate. Filter out posts below
        // the minimum engagement threshold to exclude trivially small burns.
        if (isControversialSort) {
          const scored = feedPosts
            .map(p => ({
              post: p,
              score: computeControversySortScore(
                BigInt(p.satsPositive ?? '0'),
                BigInt(p.satsNegative ?? '0'),
              ),
            }))
            .filter(
              ({ score }) => score >= FEED_RANKING_CONTROVERSIAL_MIN_ENGAGEMENT,
            )
            .sort((a, b) => b.score - a.score)
          const pageStart = (normalizedPage - 1) * normalizedPageSize
          const paginated = scored
            .slice(pageStart, pageStart + normalizedPageSize)
            .map(({ post }) => post)
          return {
            posts: paginated,
            pagination: {
              page: normalizedPage,
              pageSize: normalizedPageSize,
              totalPages,
              totalItems,
              hasNext: normalizedPage < totalPages,
              hasPrev: normalizedPage > 1,
            },
          }
        }

        // R63: apply z-score capping across the candidate set, then
        // re-sort by dampened score and paginate for 'curated' mode.
        if (isDampened) {
          const rawScores = feedPosts.map(p => p.feedScore ?? 0)
          const cappedScores = applyZScoreCapping(rawScores)
          for (let i = 0; i < feedPosts.length; i++) {
            feedPosts[i].feedScoreNormalized = cappedScores[i]
          }
          feedPosts.sort(
            (a, b) =>
              (b.feedScoreNormalized ?? 0) - (a.feedScoreNormalized ?? 0),
          )
          const pageStart = (normalizedPage - 1) * normalizedPageSize
          const paginated = feedPosts.slice(
            pageStart,
            pageStart + normalizedPageSize,
          )
          return {
            posts: paginated,
            pagination: {
              page: normalizedPage,
              pageSize: normalizedPageSize,
              totalPages,
              totalItems,
              hasNext: normalizedPage < totalPages,
              hasPrev: normalizedPage > 1,
            },
          }
        }

        return {
          posts: feedPosts,
          pagination: {
            page: normalizedPage,
            pageSize: normalizedPageSize,
            totalPages,
            totalItems,
            hasNext: normalizedPage < totalPages,
            hasPrev: normalizedPage > 1,
          },
        }
      })
    } catch (e) {
      throw new Error(`db.apiGetFeedPosts: ${e.message}`)
    }
  }

  /**
   * Retrieves trending posts based on recent burn activity, applying the full
   * R62–R66 dampening pipeline:
   *   R62: aggregate logarithmic dampening per post
   *   R64: temporal conviction accumulation (exponential decay by age)
   *   R65: bidirectional signal fields (sentimentRatio, controversyScore, isControversial)
   *   R66: burn velocity spike dampening (sigmoid on window burns vs rolling median)
   *
   * Phase 1 fetches a larger candidate set sorted by aggregate window burns
   * (Sybil-neutral: total sats, not vote count). Phase 2 applies dampening
   * and re-sorts, then returns the top `limit` results.
   *
   * @param windowHours - Time window in hours (default 24h)
   * @param limit - Maximum number of results (default 20)
   * @param scriptPayload - Optional wallet for Vote-to-Reveal metadata
   * @returns Array of PostAPI objects ordered by dampened trending score
   */
  async apiGetTrendingPosts(
    windowHours: number = 24,
    limit: number = 20,
    scriptPayload?: string,
  ): Promise<PostAPI[]> {
    try {
      const nowSeconds = Math.floor(Date.now() / 1000)
      const startTimestamp = nowSeconds - windowHours * 3600
      const velocityWindowSeconds = FEED_RANKING_VELOCITY_WINDOW_HOURS * 3600
      const velocityWindowStart = nowSeconds - velocityWindowSeconds

      // Phase 1: Find post IDs with the most aggregate burn in the window.
      // Sort by _sum.sats (total burned) rather than _count.txid (vote count)
      // to avoid rewarding Sybil wallet splitting.
      const candidateLimit = Math.min(limit * 5, 200)
      const trendingGroups = await this.db.rankTransaction.groupBy({
        by: ['platform', 'profileId', 'postId'],
        where: {
          timestamp: { gte: startTimestamp },
          postId: { not: null },
        },
        _count: { txid: true },
        _sum: { sats: true },
        orderBy: { _sum: { sats: 'desc' } },
        take: candidateLimit,
      })

      // Compute rolling median of window burns across all candidates for R66.
      // This gives us a baseline to detect velocity spikes.
      const windowBurns = trendingGroups
        .map(g => Number(g._sum.sats ?? 0n))
        .sort((a, b) => a - b)
      const medianWindowBurns =
        windowBurns.length > 0
          ? windowBurns[Math.floor(windowBurns.length / 2)]
          : 1

      // Fetch velocity-window burns for each candidate (R66).
      // This is the burn amount in the short detection window vs the full trend window.
      const velocityGroups = await this.db.rankTransaction.groupBy({
        by: ['platform', 'profileId', 'postId'],
        where: {
          timestamp: { gte: velocityWindowStart },
          postId: { not: null },
        },
        _sum: { sats: true },
      })
      const velocityMap = new Map<string, bigint>()
      for (const vg of velocityGroups) {
        if (vg.postId) {
          velocityMap.set(
            `${vg.platform}:${vg.profileId}:${vg.postId}`,
            vg._sum.sats ?? 0n,
          )
        }
      }

      if (!trendingGroups.length) {
        return []
      }

      // Wallet-specific RANK vote filter
      const includeRanks = this.buildIncludeRanksClause(scriptPayload)

      // Phase 2: Fetch full Post data for each trending post
      const posts = await this.db.$transaction(
        trendingGroups.map(group =>
          this.db.post.findFirst({
            where: {
              platform: group.platform,
              profileId: group.profileId,
              id: group.postId,
            },
            include: {
              profile: {
                select: targetEntityMetricsSelect,
              },
              comment: {
                select: {
                  inReplyToPlatform: true,
                  inReplyToProfileId: true,
                  inReplyToPostId: true,
                  timestamp: true,
                  firstSeen: true,
                },
              },
              comments: {
                include: {
                  post: {
                    include: {
                      profile: {
                        select: targetEntityMetricsSelect,
                      },
                    },
                  },
                },
              },
              ranks: includeRanks,
            },
          }),
        ),
      )

      // Phase 3: Convert to PostAPI shape, applying R62/R64/R65/R66 dampening
      const result: PostAPI[] = []
      for (let i = 0; i < posts.length; i++) {
        const post = posts[i]
        if (!post) continue
        // R64: trending/recent feed uses lastVoted as the decay anchor so
        // re-emerging content with genuine new activity surfaces correctly.
        const decayAnchor = Number(post.lastVoted)

        // R66: compute velocity dampening for this post
        const velocityKey = `${post.platform}:${post.profileId}:${post.id}`
        const velocityBurns = velocityMap.get(velocityKey) ?? 0n
        const velocityDampening = computeVelocityDampening(
          velocityBurns,
          BigInt(Math.floor(medianWindowBurns)),
        )

        // R62 + R64 + R65/R66: composite score with temporal decay and velocity dampening
        const signals = computeCompositeFeedScore(
          post.satsPositive,
          post.satsNegative,
          decayAnchor,
          velocityDampening,
        )

        const postData: PostAPI = {
          id: post.id,
          platform: post.platform as ScriptChunkPlatformUTF8,
          profileId: post.profileId,
          firstVoted: post.firstVoted?.toString() ?? null,
          lastVoted: post.lastVoted?.toString() ?? null,
          ...this.serializeEntityMetrics(post),
          profile: this.serializeEntityMetrics(post.profile),
          feedScore: signals.feedScore,
          sentimentRatio: signals.sentimentRatio,
          controversyScore: signals.controversyScore,
          totalEngagement: signals.totalEngagement,
          isControversial: signals.isControversial,
        }
        if (post.data && post.comment) {
          this.populateLotusiaPostFields(postData, post.data, post.comment)
        }
        if (post.comments?.length) {
          postData.comments = []
          for (const reply of post.comments) {
            postData.comments.push(
              this.convertRankCommentToPostAPI(
                reply as unknown as IndexedTransactionRNKC,
              ),
            )
          }
        }
        if (post.ranks?.length) {
          postData.postMeta = await this.buildPostMeta(post.ranks)
        }
        result.push(postData)
      }

      // Re-sort by dampened feedScore (R62+R64+R66) and return top `limit`
      result.sort((a, b) => (b.feedScore ?? 0) - (a.feedScore ?? 0))
      return result.slice(0, limit)
    } catch (e) {
      throw new Error(`db.apiGetTrendingPosts: ${e.message}`)
    }
  }

  /**
   * Retrieves a leaderboard of top voters ranked by total sats burned in a period.
   * Used for the Leaderboard page (Phase 5.4) and the `getLeaderboard` API composable
   * method specified in 02-FEED-AND-ONBOARDING.md.
   *
   * @param period - Time period ('daily' or 'weekly')
   * @param limit - Maximum number of entries (default 20)
   * @returns Array of leaderboard entries with wallet stats
   */
  async apiGetLeaderboard(period: 'daily' | 'weekly', limit: number = 20) {
    try {
      const startTime = period === 'daily' ? 'today' : 'week'
      const startTimestamp = getTimestampUTC(startTime as Timespan)

      const results = await this.db.rankTransaction.groupBy({
        by: ['scriptPayload'],
        where: {
          timestamp: { gte: startTimestamp },
        },
        _count: { txid: true },
        _sum: { sats: true },
        orderBy: { _sum: { sats: 'desc' } },
        take: Math.min(limit, 100),
      })

      // Enrich with WalletEngagement data if available
      const leaderboard = await Promise.all(
        results.map(async (entry, index) => {
          let engagement: {
            tier: number
            currentStreak: number
            engagementPoints: number
          } | null = null
          try {
            engagement = await this.db.walletEngagement.findUnique({
              where: { scriptPayload: entry.scriptPayload },
              select: {
                tier: true,
                currentStreak: true,
                engagementPoints: true,
              },
            })
          } catch {
            // WalletEngagement may not exist for this wallet
          }
          return {
            rank: index + 1,
            scriptPayload: entry.scriptPayload,
            totalVotes: entry._count.txid,
            totalBurned: entry._sum.sats?.toString() ?? '0',
            tier: engagement?.tier ?? 0,
            currentStreak: engagement?.currentStreak ?? 0,
            engagementPoints: engagement?.engagementPoints ?? 0,
          }
        }),
      )

      return leaderboard
    } catch (e) {
      throw new Error(`db.apiGetLeaderboard: ${e.message}`)
    }
  }

  // ─── Private Helpers ──────────────────────────────────────────────────

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

    return Object.values(voterDetails)
  }
  /**
   * Walks up the inReplyToPostId chain from a given post, collecting each
   * ancestor as a PostAPI, until reaching the genesis post (no inReplyToPostId).
   *
   * Returns ancestors ordered from genesis (index 0) to immediate parent (last index).
   * Caps traversal at 20 hops to prevent infinite loops from malformed data.
   *
   * @param tx - Prisma transaction client (this method is called within a transaction)
   * @param inReplyToPlatform - Platform of the immediate parent
   * @param inReplyToProfileId - ProfileId of the immediate parent
   * @param inReplyToPostId - PostId of the immediate parent
   * @param maxDepth - Maximum depth to traverse (default: 20)
   * @param scriptPayload - Optional wallet script payload; when provided, populates `postMeta` on each ancestor
   */
  private async fetchAncestorChain(
    tx: PrismaClient,
    inReplyToPlatform: string,
    inReplyToProfileId: string,
    inReplyToPostId: string,
    maxDepth: number = 20,
    scriptPayload?: string,
  ): Promise<PostAPI[]> {
    const ancestors: PostAPI[] = []
    const includeRanks = this.buildIncludeRanksClause(scriptPayload)

    let currentPlatform = inReplyToPlatform
    let currentProfileId = inReplyToProfileId
    let currentPostId = inReplyToPostId

    for (let i = 0; i < maxDepth; i++) {
      try {
        const post = await tx.post.findUnique({
          where: {
            platform_profileId_id: {
              platform: currentPlatform,
              profileId: currentProfileId,
              id: currentPostId,
            },
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
            comment: {
              select: {
                data: true,
                inReplyToPlatform: true,
                inReplyToProfileId: true,
                inReplyToPostId: true,
                timestamp: true,
                firstSeen: true,
              },
            },
            ranks: includeRanks,
          },
        })

        if (!post) break

        const ancestorAPI: PostAPI = {
          id: post.id,
          platform: post.platform as ScriptChunkPlatformUTF8,
          profileId: post.profileId,
          firstVoted: post.firstVoted?.toString() ?? null,
          lastVoted: post.lastVoted?.toString() ?? null,
          ...this.serializeEntityMetrics(post),
          profile: this.serializeEntityMetrics(post.profile),
        }

        // Populate RNKC-specific fields if this ancestor is a Lotusia comment
        if (post.comment) {
          this.populateLotusiaPostFields(ancestorAPI, post.data, post.comment)
        }

        // Populate wallet-specific vote metadata when scriptPayload is provided
        if (post.ranks?.length) {
          ancestorAPI.postMeta = await this.buildPostMeta(post.ranks)
        }

        // Prepend so final array is root-first
        ancestors.unshift(ancestorAPI)

        // Walk up to the next ancestor if this post is also a reply
        if (post.comment?.inReplyToPostId) {
          currentPlatform = post.comment.inReplyToPlatform
          currentProfileId = post.comment.inReplyToProfileId
          currentPostId = post.comment.inReplyToPostId
        } else {
          // Reached genesis post — stop
          break
        }
      } catch {
        break
      }
    }

    return ancestors
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
      data: BufferUtil.from(rnkc.data).toString('utf-8'),
      firstVoted: rnkc.post.firstVoted?.toString(),
      lastVoted: rnkc.post.lastVoted?.toString(),
      inReplyToPlatform: rnkc.inReplyToPlatform as ScriptChunkPlatformUTF8,
      inReplyToProfileId: rnkc.inReplyToProfileId,
      inReplyToPostId: rnkc.inReplyToPostId,
      firstSeen: (rnkc.firstSeen / 1_000n).toString(),
      timestamp: rnkc.timestamp?.toString(),
      ...this.serializeEntityMetrics(rnkc.post),
      profile: this.serializeEntityMetrics(rnkc.post.profile),
    }
  }
  /**
   * Normalizes pagination parameters to safe, bounded values.
   * @param page - Raw page number (1-based)
   * @param pageSize - Raw page size
   * @param maxPageSize - Upper bound for pageSize (default 40)
   * @returns Normalized { page, pageSize }
   */
  private normalizePaginationParams(
    page: number,
    pageSize: number,
    maxPageSize: number = 40,
  ): { page: number; pageSize: number } {
    if (!page || page < 1) {
      page = 1
    }
    if (!pageSize) {
      pageSize = 10
    }
    if (pageSize > maxPageSize) {
      pageSize = maxPageSize
    }
    return { page, pageSize }
  }
  /**
   * Serializes a raw entity's BigInt metric fields to strings for API responses.
   * @param entity - Object with ranking/satsPositive/satsNegative as bigint and votes as number
   * @returns `TargetEntityMetricsAPI`
   */
  private serializeEntityMetrics(entity: {
    ranking: bigint
    satsPositive: bigint
    satsNegative: bigint
    votesPositive: number
    votesNegative: number
  }): TargetEntityMetricsAPI {
    return {
      ranking: entity.ranking.toString(),
      satsPositive: entity.satsPositive.toString(),
      satsNegative: entity.satsNegative.toString(),
      votesPositive: entity.votesPositive,
      votesNegative: entity.votesNegative,
    }
  }
  /**
   * Builds a `VoterProfileMetadata` object from a ranks array.
   * Returns `null` when the ranks array is empty or undefined.
   * @param ranks - Array of rank records with a `sentiment` field
   * @returns `VoterProfileMetadata` or null
   */
  private buildProfileMetadata(
    ranks: { sentiment: string }[] | undefined | null,
  ): VoterProfileMetadata | null {
    if (!ranks?.length) {
      return null
    }
    return {
      hasWalletUpvoted: ranks.some(r => r.sentiment === 'positive'),
      hasWalletDownvoted: ranks.some(r => r.sentiment === 'negative'),
    }
  }
  /**
   * Builds the Prisma `include.ranks` clause used to fetch wallet-specific vote
   * data for Vote-to-Reveal (postMeta). Returns `undefined` when no scriptPayload
   * is provided so Prisma omits the relation entirely.
   * @param scriptPayload - Optional wallet script payload
   * @returns Prisma include clause or undefined
   */
  private buildIncludeRanksClause(
    scriptPayload: string | undefined,
    timespan?: Timespan,
  ) {
    if (!scriptPayload) {
      return undefined
    }
    const clause: Parameters<typeof this.db.rankTransaction.findMany>[0] = {
      where: {
        scriptPayload,
        sentiment: { not: 'neutral' },
        // TODO: This needs to be fixed in another way specifically for recent vote data
        // Recent vote data is used in sentiment charts in lotus-web-wallet for profiles/posts
        // The problem is that setting a filter here will fail to generate full postMeta for a profile/post
        //timestamp: { gte: getTimestampUTC(timespan) }, // timespan defaults to 'week'
      },
      select: {
        txid: true,
        sats: true,
        sentiment: true,
        timestamp: true, // null if tx is unconfirmed
        firstSeen: true, // first time seen by indexer; good practice to defer to block timestamp for old txs
      },
      orderBy: [
        {
          timestamp: 'desc',
        },
        {
          firstSeen: 'desc',
        },
      ],
    }

    // Add timespan filter if provided, otherwise fetches all ranks
    if (timespan) {
      clause.where.timestamp = {
        gte: getTimestampUTC(timespan),
      }
    }

    return clause
  }
  /**
   * Populates Lotusia-specific RNKC fields on a `PostAPI` object in-place.
   * Decodes the raw post data buffer, sets inReplyTo fields, and resolves the
   * canonical timestamp (min of firstSeen and block timestamp).
   * @param postData - The `PostAPI` object to mutate
   * @param rawData - Raw post data buffer (from `post.data`)
   * @param comment - The associated RankComment record
   */
  private populateLotusiaPostFields(
    postData: PostAPI,
    rawData: Buffer | Uint8Array,
    comment: {
      inReplyToPlatform: string
      inReplyToProfileId: string
      inReplyToPostId: string | null
      timestamp: bigint
      firstSeen: bigint
    },
  ): void {
    postData.data = BufferUtil.from(rawData).toString('utf-8')
    postData.inReplyToPlatform =
      comment.inReplyToPlatform as ScriptChunkPlatformUTF8
    postData.inReplyToProfileId = comment.inReplyToProfileId
    postData.inReplyToPostId = comment.inReplyToPostId
    const firstSeenSeconds = comment.firstSeen / 1_000n
    postData.firstSeen = firstSeenSeconds.toString()
    postData.timestamp =
      firstSeenSeconds < comment.timestamp
        ? firstSeenSeconds.toString()
        : (comment.timestamp?.toString() ?? null)
  }
  /**
   * Converts a list of rank transactions to a PostMeta
   * @param ranks - The list of rank transactions to convert
   * @returns The `VoterPostMetadata` object
   */
  private async buildPostMeta(
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
