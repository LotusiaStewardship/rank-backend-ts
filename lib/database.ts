import { PrismaClient } from '@prisma/client'
import { randomUUID } from 'crypto'
import { API_STATS_RESULT_COUNT, ERR } from '../util/constants'
import type {
  Block,
  RankTransaction,
  Profile,
  ProfileMap,
  ScriptChunkPlatformUTF8,
} from 'rank-lib'

type Timespan = 'day' | 'week' | 'month' | 'quarter' | 'all'
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

  constructor() {
    this.db = new PrismaClient({
      errorFormat: 'minimal',
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
  async apiGetPlatformProfile(
    platform: ScriptChunkPlatformUTF8,
    profileId: string,
    include?: {
      ranks?: boolean
      posts?: boolean
    },
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
                  /*
                  include: {
                    block: {
                      select: {

                      }
                    }
                  }
                  */
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
   *
   * @param platform
   * @returns
   */
  async getStatsPlatformProfilesTopRanked(
    platform: ScriptChunkPlatformUTF8,
    timespan: Timespan = 'day',
    includeVotes: boolean,
    pageNum: number = 0,
  ) {
    try {
      const result = await this.db.profile.findMany({
        where: {
          platform,
          ranking: {
            gt: 0n,
          },
          ranks: {
            every: {
              timestamp: { gte: getTimestampUTC(timespan) },
            },
          },
        },
        orderBy: {
          ranking: 'desc',
        },
        take: API_STATS_RESULT_COUNT,
        select: {
          platform: true,
          id: true,
          ranking: true,
          votesPositive: true,
          votesNegative: true,
          ranks: !includeVotes
            ? undefined
            : {
                select: {
                  txid: true,
                },
                orderBy: {
                  timestamp: 'desc',
                },
                skip: pageNum ? 10 * pageNum : undefined,
                take: 10,
              },
        },
      })
      return result.map(profile => {
        return {
          platform: profile.platform,
          profileId: profile.id,
          ranking: String(profile.ranking),
          votesPositive: profile.votesPositive,
          votesNegative: profile.votesNegative,
          votesTimespan: profile.ranks?.map(rank => rank.txid) ?? [],
        }
      })
    } catch (e) {
      throw new Error(`db.getStatsPlatformProfilesTopRanked: ${e.message}`)
    }
  }
  /**
   *
   * @param platform
   * @returns
   */
  async getStatsPlatformProfilesLowestRanked(
    platform: ScriptChunkPlatformUTF8,
    timespan: Timespan = 'day',
    includeVotes: boolean,
    pageNum: number = 0,
  ) {
    try {
      const result = await this.db.profile.findMany({
        where: {
          platform,
          ranking: { lt: 0n },
          ranks: {
            every: {
              timestamp: { gte: getTimestampUTC(timespan) },
            },
          },
        },
        orderBy: {
          ranking: 'asc',
        },
        take: API_STATS_RESULT_COUNT,
        select: {
          platform: true,
          id: true,
          ranking: true,
          votesPositive: true,
          votesNegative: true,
          ranks: !includeVotes
            ? undefined
            : {
                select: {
                  txid: true,
                },
                orderBy: {
                  timestamp: 'desc',
                },
                skip: pageNum ? 10 * pageNum : undefined,
                take: 10,
              },
        },
      })
      return result.map(profile => {
        return {
          platform: profile.platform,
          profileId: profile.id,
          ranking: String(profile.ranking),
          votesPositive: profile.votesPositive,
          votesNegative: profile.votesNegative,
          votesTimespan: profile.ranks?.map(rank => rank.txid) ?? [],
        }
      })
    } catch (e) {
      throw new Error(`db.getStatsPlatformProfilesLowestRanked: ${e.message}`)
    }
  }
  /**
   *
   * @param platform
   * @returns
   */
  async getStatsPlatformPostsTopRanked(
    platform: ScriptChunkPlatformUTF8,
    timespan: Timespan = 'day',
    includeVotes: boolean,
    pageNum: number = 0,
  ) {
    try {
      const result = await this.db.post.findMany({
        where: {
          platform,
          ranking: {
            gt: 0n,
          },
          ranks: {
            every: {
              timestamp: { gte: getTimestampUTC(timespan) },
            },
          },
        },
        orderBy: {
          ranking: 'desc',
        },
        take: 5,
        select: {
          platform: true,
          profileId: true,
          id: true,
          ranking: true,
          votesPositive: true,
          votesNegative: true,
          ranks: !includeVotes
            ? undefined
            : {
                select: {
                  txid: true,
                },
                orderBy: {
                  timestamp: 'desc',
                },
                skip: pageNum ? 10 * pageNum : undefined,
                take: 10,
              },
        },
      })
      return result.map(post => {
        return {
          platform: post.platform,
          profileId: post.profileId,
          postId: post.id,
          ranking: String(post.ranking),
          votesPositive: post.votesPositive,
          votesNegative: post.votesNegative,
          votesTimespan: post.ranks?.map(rank => rank.txid) ?? [],
        }
      })
    } catch (e) {
      throw new Error(`db.getStatsPlatformPostsLowestRanked: ${e.message}`)
    }
  }
  /**
   *
   * @param platform
   * @returns
   */
  async getStatsPlatformPostsLowestRanked(
    platform: ScriptChunkPlatformUTF8,
    timespan: Timespan = 'day',
    includeVotes: boolean,
    pageNum: number = 0,
  ) {
    try {
      const result = await this.db.post.findMany({
        where: {
          platform,
          ranking: {
            lt: 0n,
          },
          ranks: {
            every: {
              timestamp: { gte: getTimestampUTC(timespan) },
            },
          },
        },
        orderBy: {
          ranking: 'asc',
        },
        take: 5,
        select: {
          platform: true,
          profileId: true,
          id: true,
          ranking: true,
          votesPositive: true,
          votesNegative: true,
          ranks: !includeVotes
            ? undefined
            : {
                select: {
                  txid: true,
                },
                orderBy: {
                  timestamp: 'desc',
                },
                skip: pageNum ? 10 * pageNum : undefined,
                take: 10,
              },
        },
      })
      return result.map(post => {
        return {
          platform: post.platform,
          profileId: post.profileId,
          postId: post.id,
          ranking: String(post.ranking),
          votesPositive: post.votesPositive,
          votesNegative: post.votesNegative,
          votesTimespan: post.ranks?.map(rank => rank.txid) ?? [],
        }
      })
    } catch (e) {
      throw new Error(`db.getStatsPlatformPostsLowestRanked: ${e.message}`)
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
                  createMany: { data: ranks },
                },
              },
              // post exists
              update: {
                ranks: {
                  createMany: { data: ranks },
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
