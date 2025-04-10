import { PrismaClient } from '../prisma/prisma-client-js'
import { randomUUID } from 'crypto'
import { API_STATS_RESULT_COUNT, ERR } from '../util/constants'
import type {
  Block,
  RankTransaction,
  Profile,
  ProfileMap,
  RankTarget,
  ScriptChunkPlatformUTF8,
  ScriptChunkSentimentUTF8,
} from 'rank-lib'

type RankStatistics = Pick<
  RankTarget,
  'ranking' | 'votesPositive' | 'votesNegative'
>
type Timespan = 'today' | 'day' | 'week' | 'month' | 'quarter' | 'all'
export type ScriptPayloadActivity = {
  scriptPayload: string
  voteCount: number
  /** Total number of sats burned during `Timespan` */
  sats: bigint
}
/**
 * Get the 00:00 UTC epoch timestamp for the previous `Timespan`, in seconds
 * @param timespan `day`, `week`, etc.
 * @returns {number} the UTC epoch timestamp beginning the `Timespan`, in seconds
 */
const getTimestampUTC = (timespan: Timespan): number => {
  const now = new Date(Date.now())
  const today = Math.floor(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) / 1_000,
  )
  switch (timespan) {
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

  constructor(datasourceUrl: string) {
    this.db = new PrismaClient({
      errorFormat: 'minimal',
      datasourceUrl,
    })
  }

  async connect() {
    try {
      await this.db.$connect()
    } catch (e) {
      throw [ERR.IDX_DATABASE_CONNECT, e.message]
    }
  }

  async disconnect() {
    await this.db.$disconnect()
  }
  /**
   * Get the detailed activity of the specified `scriptPayload` over `Timespan` time
   * @param timespan
   * @param scriptPayload
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
   * Get the summarized activity of all `scriptPayload`s over `Timespan` time
   * @param timespan
   * @returns {Promise<ScriptPayloadActivity[]>} Array of `ScriptPayloadActivity`
   */
  async ipcGetScriptPayloadActivitySummary({
    startTime,
    endTime,
  }: {
    startTime?: Timespan
    endTime?: Timespan
  }): Promise<ScriptPayloadActivity[]> {
    if (!startTime) {
      startTime = 'day'
    }
    if (!endTime) {
      endTime = 'today'
    }
    return await this.db.$transaction(async tx => {
      try {
        const group = await tx.rankTransaction.groupBy({
          by: ['scriptPayload'],
          where: {
            timestamp: {
              gte: getTimestampUTC(startTime),
              lte: getTimestampUTC(endTime),
            },
          },
          _count: true,
          _sum: {
            sats: true,
          },
        })
        return group.map(
          ({ scriptPayload, _count, _sum }) =>
            ({
              scriptPayload,
              voteCount: _count,
              sats: _sum.sats,
            }) as ScriptPayloadActivity,
        )
      } catch (e) {
        throw new Error(`db.ipcGetScriptPayloadActivity: ${e.message}`)
      }
    })
  }
  /**
   *
   * @param platform
   * @param profileId
   * @returns
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
      }
      // always return data, even if default profile data
      return data
    })
  }
  /**
   *
   * @param platform
   * @param profileId
   * @param postId
   * @param scriptPayload
   * @returns
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
      }
      // always return data, even if default profile data
      return data
    })
  }
  /**
   *
   * @param platform
   * @returns
   */
  async getStatsPlatformRanked({
    platform,
    dataType,
    rankingType,
    startTime,
    endTime,
    includeVotes,
    pageNum,
  }: {
    platform: ScriptChunkPlatformUTF8
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
      endTime = 'today'
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
          platform,
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
                  platform,
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
                item.profileId && dataType == 'postId'
                  ? { profileId: item.profileId, postId: item.id }
                  : { profileId: item.id }
              return {
                platform,
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
   *
   * @param profiles
   * @returns
   */
  async rewindProfiles(profiles: ProfileMap) {
    try {
      await this.db.$transaction(this.toProfileRewindStatements(profiles))
    } catch (e) {
      throw new Error(`rewindProfiles: ${e.message}`)
    }
  }
  /**
   *
   * @param profiles
   */
  async upsertProfiles(profiles: ProfileMap) {
    try {
      await this.db.$transaction(this.toProfileUpsertStatements(profiles))
    } catch (e) {
      throw new Error(`upsertProfiles: ${e.message}`)
    }
  }
  /**
   *
   * @param height
   * @returns
   */
  async getRankTransactionsByHeight(
    height: number,
  ): Promise<RankTransaction[]> {
    try {
      return await this.db.rankTransaction.findMany({
        where: { height },
      })
    } catch (e) {
      throw new Error(`getRankTransactionsByHeight: ${e.message}`)
    }
  }
  /**
   *
   * @param height
   * @returns
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
   *
   * @param height
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
   *
   * @param block
   * @param txids
   * @param profiles
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
        ...this.toProfileUpsertStatements(profiles),
      ])
    } catch (e) {
      throw new Error(
        `saveBlock(${block.height}, ${rankTxids.length}, ${typeof profiles}): ${e.message}`,
      )
    }
  }
  /**
   *
   * @param blocks
   * @param profiles
   */
  async saveBlockRange(blocks: Block[], profiles: ProfileMap) {
    try {
      await this.db.$transaction([
        // Create all of the blocks first for `height` pkey
        this.db.block.createMany({ data: blocks }),
        // Upsert all profiles
        // These RANK txs are automatically connected to their block by height
        ...this.toProfileUpsertStatements(profiles),
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
   *
   * @param profiles
   * @returns
   */
  toProfileUpsertStatements(profiles: ProfileMap) {
    const upserts: ReturnType<
      typeof this.db.post.upsert | typeof this.db.profile.upsert
    >[] = []
    for (const [id, profile] of profiles) {
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
        for (const [id, post] of profile.posts) {
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
   *
   * @param profiles
   * @returns
   */
  toProfileRewindStatements(profiles: ProfileMap) {
    const rewinds: ReturnType<
      typeof this.db.post.update | typeof this.db.profile.update
    >[] = []
    for (const [id, profile] of profiles) {
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
}
