/* eslint-disable no-unsafe-finally */
import { PrismaClient } from '../prisma/prisma-client-js'
import { randomUUID } from 'crypto'
import { API_STATS_RESULT_COUNT, ERR } from '../util/constants'
import type {
  Block,
  RankTransaction,
  Profile,
  ProfileMap,
  Post,
  PostMap,
  RankTarget,
  ScriptChunkPlatformUTF8,
  ScriptChunkSentimentUTF8,
} from 'rank-lib'

type RankStatistics = Pick<
  RankTarget,
  'ranking' | 'votesPositive' | 'votesNegative'
>
export type Timespan =
  | 'now'
  | 'today'
  | 'day'
  | 'week'
  | 'month'
  | 'quarter'
  | 'all'
export type ScriptPayloadActivitySummary = {
  scriptPayload: string
  totalVotes: number
  /** Total number of sats burned during `Timespan` */
  totalSats: string
  lastSeen: string
  firstSeen: string
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

export default class Database {
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
   * Retrieves detailed activity data for a specific script payload within a given time range
   * @param scriptPayload - The script payload to query activity for
   * @param startTime - Optional start time for the query period
   * @param endTime - Optional end time for the query period
   * @returns Promise resolving to an array of rank transactions with timestamps
   */
  async ipcGetScriptPayloadActivity({
    scriptPayload,
    startTime,
    endTime,
  }: {
    scriptPayload: string
    startTime?: Timespan
    endTime?: Timespan
  }) {
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
      return results.map(result => ({
        date: new Date(Number(result.timestamp * 1_000n)).toISOString(),
        ...result,
      }))
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
  }): Promise<ScriptPayloadActivitySummary[]> {
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
          }) as ScriptPayloadActivitySummary,
      )
    } catch (e) {
      throw new Error(`db.ipcGetScriptPayloadActivity: ${e.message}`)
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
      await this.db.extensionInstance.create({ data })
      return { error: null }
    } catch (e) {
      return { error: JSON.stringify(e.message) }
    }
  }
  /**
      data.totalVotes = data.totalUpvotes + data.totalDownvotes
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
   * Retrieves profile information for a specific platform and profile ID
   * @param platform The platform identifier (ScriptChunkPlatformUTF8)
   * @param profileId The unique identifier of the profile
   * @returns Profile data including ranking and vote statistics
   */
  async apiGetPlatformProfile(
    platform: ScriptChunkPlatformUTF8,
    profileId: string,
  ) {
    const data = {
      platform,
      profileId,
      ranking: '0',
      votesPositive: 0,
      votesNegative: 0,
    }
    return await this.db.$transaction(async tx => {
      try {
        const profile = await tx.profile.findUniqueOrThrow({
          where: {
            platform_id: { platform, id: profileId },
          },
        })
        // Add indexed post data to return data
        data.ranking = profile.ranking.toString()
        data.votesPositive = profile.votesPositive
        data.votesNegative = profile.votesNegative
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
    const data = {
      platform,
      profileId,
      profile: {
        ranking: '0',
        votesPositive: 0,
        votesNegative: 0,
      },
      postId,
      postMeta: null,
      ranking: '0',
      votesPositive: 0,
      votesNegative: 0,
    }
    return await this.db.$transaction(async tx => {
      try {
        const post = await tx.post.findUniqueOrThrow({
          where: {
            platform_profileId_id: { platform, profileId, id: postId },
          },
          include: {
            profile: {
              select: {
                ranking: true,
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
        // Add indexed post data to return data
        data.ranking = post.ranking.toString()
        data.votesPositive = post.votesPositive
        data.votesNegative = post.votesNegative
        // set up post metadata
        if (post.ranks.length) {
          const postMeta = {
            hasWalletUpvoted: false,
            hasWalletDownvoted: false,
            txidsUpvoted: [],
            txidsDownvoted: [],
          }
          post.ranks.forEach(rank => {
            switch (rank.sentiment) {
              case 'positive':
                postMeta.hasWalletUpvoted = true
                postMeta.txidsUpvoted.push(rank.txid)
                break
              case 'negative':
                postMeta.hasWalletDownvoted = true
                postMeta.txidsDownvoted.push(rank.txid)
                break
            }
          })
          data.postMeta = postMeta
        }
        data.profile = {
          ranking: post.profile.ranking.toString(),
          votesPositive: post.profile.votesPositive,
          votesNegative: post.profile.votesNegative,
        }
      } catch (e) {
        // fetch the indexed profile if the post doesn't exist
        const profile = await tx.profile.findUniqueOrThrow({
          where: {
            platform_id: { platform, id: profileId },
          },
          select: {
            ranking: true,
            votesPositive: true,
            votesNegative: true,
          },
        })
        data.profile = {
          ranking: profile.ranking.toString(),
          votesPositive: profile.votesPositive,
          votesNegative: profile.votesNegative,
        }
      } finally {
        // always return data, even if default profile data
        return data
      }
    })
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
      const ranksByProfileIdSentiment = await this.db.rankTransaction.groupBy({
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
      const dataChanges: Map<
        string,
        {
          ranking: bigint
          votesPositive: number
          votesNegative: number
        }
      > = new Map()
      ranksByProfileIdSentiment.forEach(rank => {
        const { _count, _sum, sentiment } = rank
        if (!dataChanges.has(rank[dataType])) {
          dataChanges.set(rank[dataType], {
            ranking: 0n,
            votesPositive: 0,
            votesNegative: 0,
          })
        }
        const data = dataChanges.get(rank[dataType])
        switch (sentiment as ScriptChunkSentimentUTF8) {
          case 'positive': {
            data.ranking += BigInt(_sum.sats)
            data.votesPositive += _count.sentiment
            break
          }
          case 'negative': {
            data.ranking -= BigInt(_sum.sats)
            data.votesNegative += _count.sentiment
            break
          }
        }
      })
      // sort the calculated rankings according to highest or lowest
      // splice API_STATS_RESULT_COUNT from the front of the array
      let changesSortedFiltered: Array<[string, RankStatistics]>
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
      return (
        // Fetch current profile/post ranking data to calculate changes
        // in the API/UI (i.e. +69 upvotes today, 6.9K Lotus increase)
        (
          await this.db.$transaction(
            changesSortedFiltered.map(([id, changes]) =>
              // @ts-expect-error we don't care if the call signatures match
              // because we know that the same input data powers both queries
              this.db[dataType == 'profileId' ? 'profile' : 'post'].findFirst({
                where: {
                  id,
                },
                include: {
                  ranks: !includeVotes
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
                      },
                },
              }),
            ),
          )
        )
          // structure the return data appropriately
          .map(
            (
              item: {
                ranks: {
                  txid: string
                }[]
              } & {
                id: string
                platform: string
                profileId?: string
                ranking: bigint
                votesPositive: number
                votesNegative: number
              },
            ) => {
              const changes = dataChanges.get(item.id)
              const rankingCurrent = Number(item.ranking)
              const rankingPrevious = Number(item.ranking - changes.ranking)
              const rankingChangePercentage =
                ((rankingCurrent - rankingPrevious) / rankingPrevious) * 100
              const ids =
                dataType == 'postId'
                  ? { profileId: item.profileId, postId: item.id }
                  : { profileId: item.id }
              return {
                platform: item.platform,
                ...ids,
                total: {
                  ranking: String(item.ranking),
                  votesPositive: item.votesPositive,
                  votesNegative: item.votesNegative,
                },
                changed: {
                  ranking: String(changes.ranking),
                  rate: rankingChangePercentage.toLocaleString(undefined, {
                    minimumFractionDigits: 1,
                    maximumFractionDigits: 1,
                  }),
                  votesPositive: changes.votesPositive,
                  votesNegative: changes.votesNegative,
                },
                votesTimespan: item.ranks?.map(rank => rank.txid) ?? [],
              }
            },
          )
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
  ): Promise<RankTransaction[]> {
    try {
      const result = await this.db.rankTransaction.findMany({
        where: { height },
      })
      return result as RankTransaction[]
    } catch (e) {
      throw new Error(`getRankTransactionsByHeight: ${e.message}`)
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
   * Saves a new block with its associated rank transactions and profiles
   * @param block The block data to save
   * @param rankTxids Array of rank transaction IDs to connect to the block
   * @param profiles Map of profiles to upsert with the block
   * @throws {Error} If the save operation fails
   */
  async saveBlock(
    block: Block,
    rankTxids: Pick<RankTransaction, 'txid'>[],
    profiles: Map<string, Profile>,
  ) {
    try {
      await this.db.$transaction([
        // Create the block and connect corresponding RANK txs
        this.db.block.create({
          data: {
            ...block,
            ranks: {
              connect: rankTxids,
            },
          },
        }),
        // Upsert any profiles if necessary
        // RANK txs upserted here will be connected to above block
        ...(await this.toProfileUpsertStatements(profiles)),
      ])
    } catch (e) {
      throw new Error(
        `saveBlock(${block.height}, ${rankTxids.length}, ${typeof profiles}): ${e.message}`,
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
      })
    } catch (e) {
      throw new Error(`getCheckpoint: ${e.message}`)
    }
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
    for await (const [id, profile] of this.iterateProfiles(profiles)) {
      const { platform, ranks, ranking, votesPositive, votesNegative } = profile
      // push profile upsert first
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
            votesPositive,
            votesNegative,
            account: { create: { id: randomUUID() } },
            ranks: {
              createMany: { data: ranks },
            },
          },
          // profile exists
          update: {
            ranks: {
              createMany: { data: ranks },
            },
            ranking: {
              increment: ranking,
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
      if (profile.posts) {
        for await (const [id, post] of this.iteratePosts(profile.posts)) {
          const {
            platform,
            profileId,
            ranks,
            ranking,
            votesPositive,
            votesNegative,
          } = post
          const increments = {
            ranking: {
              increment: ranking,
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
                ranking,
                votesPositive,
                votesNegative,
                ranks: {
                  connect: ranks,
                },
              },
              // post exists
              update: {
                ranks: {
                  connect: ranks,
                },
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
    for await (const [id, profile] of this.iterateProfiles(profiles)) {
      const { platform, ranks, ranking, votesPositive, votesNegative } = profile
      // push profile rewind first
      rewinds.push(
        this.db.profile.update({
          where: {
            platform_id: { platform, id },
          },
          data: {
            ranks: {
              deleteMany: {
                txid: {
                  in: ranks.map(rank => rank.txid),
                },
              },
            },
            ranking: {
              decrement: ranking,
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
            ranking,
            votesPositive,
            votesNegative,
          } = post
          const decrements = {
            ranking: {
              decrement: ranking,
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
                ranks: {
                  deleteMany: {
                    txid: {
                      in: ranks.map(rank => rank.txid),
                    },
                  },
                },
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
   * Converts a ProfileMap into an AsyncIterable for asynchronous iteration
   * @param profiles - The ProfileMap to iterate over
   * @returns An AsyncIterable that yields [string, Profile] tuples
   * @example
   * ```typescript
   * for await (const [id, profile] of db.iterateProfiles(profiles)) {
   *   // Process each profile asynchronously
   * }
   * ```
   */
  async *iterateProfiles(
    profiles: ProfileMap,
  ): AsyncIterable<[string, Profile]> {
    for (const [id, profile] of profiles) {
      yield [id, profile]
    }
  }

  /**
   * Converts a PostMap into an AsyncIterable for asynchronous iteration
   * @param posts - The PostMap to iterate over
   * @returns An AsyncIterable that yields [string, Post] tuples
   * @example
   * ```typescript
   * for await (const [id, post] of db.iteratePosts(posts)) {
   *   // Process each post asynchronously
   * }
   * ```
   */
  async *iteratePosts(posts: PostMap): AsyncIterable<[string, Post]> {
    for (const [id, post] of posts) {
      yield [id, post]
    }
  }
}
