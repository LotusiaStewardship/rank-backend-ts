import { PrismaClient } from '@prisma/client'
import { randomUUID } from 'crypto'
import { Block, RankTransaction, Profile, ProfileMap } from './indexer'

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
  /**
   *
   * @param profileId
   * @returns
   */
  async apiGetAccountByProfileId(profileId: string) {
    try {
      return await this.db.profile.findFirst({
        where: {
          id: profileId,
        },
        select: {
          account: {
            select: {
              profiles: true,
            },
          },
        },
      })
    } catch (e) {
      throw new Error(`apiGetAccountByProfileId: ${e.message}`)
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
      throw new Error(e.message)
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
    const upserts: ReturnType<typeof this.db.profile.upsert>[] = []
    for (const [profileId, profile] of profiles) {
      upserts.push(
        this.db.profile.upsert({
          where: {
            id_platform: {
              id: profileId,
              platform: profile.platform,
            },
          },
          // profile doesn't exist
          create: {
            ...profile,
            account: { create: { id: randomUUID() } },
            ranks: {
              createMany: { data: profile.ranks },
            },
          },
          // profile exists
          update: {
            ranks: {
              createMany: { data: profile.ranks },
            },
            ranking: {
              increment: profile.ranking,
            },
            votesPositive: {
              increment: profile.votesPositive,
            },
            votesNegative: {
              increment: profile.votesNegative,
            },
          },
        }),
      )
    }
    return upserts
  }
  /**
   *
   * @param profiles
   * @returns
   */
  toProfileRewindStatements(profiles: ProfileMap) {
    const rewinds: ReturnType<typeof this.db.profile.update>[] = []
    for (const [profileId, profile] of profiles) {
      rewinds.push(
        this.db.profile.update({
          where: {
            id_platform: {
              id: profileId,
              platform: profile.platform,
            },
          },
          data: {
            ranks: {
              deleteMany: {
                txid: {
                  in: profile.ranks.map(rank => rank.txid),
                },
              },
            },
            ranking: {
              decrement: profile.ranking,
            },
            votesPositive: {
              decrement: profile.votesPositive,
            },
            votesNegative: {
              decrement: profile.votesNegative,
            },
          },
        }),
      )
    }
    return rewinds
  }
}
