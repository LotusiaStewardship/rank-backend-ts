import { PrismaClient } from '@prisma/client'
import { randomUUID } from 'crypto'
import type {
  Block,
  RankTransaction,
  Profile,
  ProfileMap,
  ScriptChunkPlatformUTF8,
} from '../util/types'

export default class Database {
  private db: PrismaClient

  constructor() {
    this.db = new PrismaClient()
  }

  async connect() {
    await this.db.$connect()
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
    try {
      const result = await this.db.profile.findUniqueOrThrow({
        where: {
          platform_id: { platform, id: profileId },
        },
      })
      return {
        platform: result.platform,
        profileId: result.id,
        ranking: String(result.ranking),
        votesPositive: result.votesPositive,
        votesNegative: result.votesNegative,
      }
    } catch (e) {
      throw new Error(`db.apiGetPlatformProfile: ${e.message}`)
    }
  }
  async apiGetPlatformProfilePost(
    platform: ScriptChunkPlatformUTF8,
    profileId: string,
    postId: string,
  ) {
    try {
      const result = await this.db.post.findUniqueOrThrow({
        where: {
          platform_profileId_id: { platform, profileId, id: postId },
        },
      })
      return {
        platform: result.platform,
        profileId: result.profileId,
        postId: result.id,
        ranking: String(result.ranking),
        votesPositive: result.votesPositive,
        votesNegative: result.votesNegative,
      }
    } catch (e) {
      throw new Error(`db.apiGetPlatformProfilePost: ${e.message}`)
    }
  }
  /**
   *
   * @param platform
   * @returns
   */
  async getStatsPlatformProfilesTopRanked(platform: ScriptChunkPlatformUTF8) {
    try {
      const result = await this.db.profile.findMany({
        where: {
          platform,
          ranking: {
            gt: 0,
          },
        },
        orderBy: {
          ranking: 'desc',
        },
        take: 5,
        select: {
          platform: true,
          id: true,
          ranking: true,
          votesPositive: true,
          votesNegative: true,
        },
      })
      return result.map(profile => {
        return {
          platform: profile.platform,
          profileId: profile.id,
          ranking: String(profile.ranking),
          votesPositive: profile.votesPositive,
          votesNegative: profile.votesNegative,
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
  ) {
    try {
      const result = await this.db.profile.findMany({
        where: {
          platform,
        },
        orderBy: {
          ranking: 'asc',
        },
        take: 5,
        select: {
          platform: true,
          id: true,
          ranking: true,
          votesPositive: true,
          votesNegative: true,
        },
      })
      return result.map(profile => {
        return {
          platform: profile.platform,
          profileId: profile.id,
          ranking: String(profile.ranking),
          votesPositive: profile.votesPositive,
          votesNegative: profile.votesNegative,
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
  async getStatsPlatformPostsTopRanked(platform: ScriptChunkPlatformUTF8) {
    try {
      const result = await this.db.post.findMany({
        where: {
          platform,
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
  async getStatsPlatformPostsLowestRanked(platform: ScriptChunkPlatformUTF8) {
    try {
      const result = await this.db.post.findMany({
        where: {
          platform,
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
      await this.db.$transaction(this.toProfileRewindStatements(profiles), {
        isolationLevel: 'RepeatableRead',
      })
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
      await this.db.$transaction(this.toProfileUpsertStatements(profiles), {
        isolationLevel: 'RepeatableRead',
      })
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
        // RANK txs upserted here are connected to above blocks
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
          // update profile rankings after post upsert
          upserts.push(
            this.db.profile.update({
              where: {
                platform_id: {
                  platform,
                  id: profileId,
                },
              },
              data: increments,
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
                // MUST decrement profile counters since post counts towards profile
                profile: {
                  update: decrements,
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
