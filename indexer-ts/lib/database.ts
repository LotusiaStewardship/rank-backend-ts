import { Prisma, PrismaClient } from "@prisma/client";
//import {}  from "@prisma/client/sql"
import BatchPayload = Prisma.BatchPayload
import type {
  Block,
  RankTransaction,
  Profile
} from './indexer'
import { randomUUID } from "crypto";

export class Database {
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
   * Checks if the profile with ID `id` exists and returns it
   * @param profileId 
   * @returns 
   */
  async getProfileById(
    profileId: string
  ): Promise<Profile | undefined> {
    try {
      return await this.db.profile.findFirst({ where: { id: profileId }})
    } catch (e: any) {
      throw new Error(`isExistingProfile: ${e.message}`)
    }
  }
  //async isExistingTransaction(txid: string) {
  //  try {
  //    const result = await this.db.rankTransaction.findFirst({
  //      where: { output: { contains: txid }},
  //      select: { output: true }
  //    })
  //    return result?.output ?? undefined
  //  } catch (e: any) {
  //
  //  }
  //}
  /**
   * 
   * @param profiles 
   * @returns 
   */
  async rewindProfiles(profiles: { [id: string]: Profile }) {
    try {
      await this.db.$transaction(
        Object.values(profiles).map(p => this.db.profile.update({
          where: { id_platform: {
            id: p.id,
            platform: p.platform
          }},
          data: {
            ranks: {
              // For REORG processing
              deleteMany: {
                txid: {
                  in: p.ranks.map(r => r.txid)
                }
              }
            },
            ranking: {
              decrement: p.ranking
            },
            ranksPositive: {
              decrement: p.ranksPositive
            },
            ranksNegative: {
              decrement: p.ranksNegative
            }
          }
        }))
      ), { isolationLevel: 'RepeatableRead' }
    } catch (e: any) {
      throw new Error(`rewindProfiles: ${e.message}`)
    }
  }
  /**
   * 
   * @param profiles 
   */
  async upsertProfiles(profiles: { [id: string]: Profile }): Promise<undefined> {
    try {
      await this.db.$transaction(
        Object.values(profiles).map(profile => {
          
          const ranks = profile.ranks.map(rank => {
            return {
              txid: rank.txid,
              value: rank.value,
              sentiment: rank.sentiment,
              timestamp: rank.timestamp,
              height: rank.height
            }
          })
          const ranksCreateMany = {
            createMany: {
              data: ranks
            }
          }
          return this.db.profile.upsert({
            where: { id_platform: {
              id: profile.id,
              platform: profile.platform
            }},
            create: {
              account: { create: { id: randomUUID() }},
              ...profile,
              ranks: ranksCreateMany,
            },
            update: {
              ranks: ranksCreateMany,
              ranking: {
                increment: profile.ranking
              },
              ranksPositive: {
                increment: profile.ranksPositive
              },
              ranksNegative: {
                increment: profile.ranksNegative
              }
            },
          })
        })
      ), { isolationLevel: 'RepeatableRead' }
    } catch (e: any) {
      throw new Error(`upsertProfiles: ${e.message}`)
    }
  }
  /**
   * 
   * @param ranks 
   */
  async updateRankTransactions(
    ranks: RankTransaction[]
  ) {
    try {
      await this.db.$transaction(
        ranks.map(rank => {
          const { height, timestamp, txid } = rank
          return this.db.rankTransaction.update({
            where: { txid },
            data: {
              height,
              timestamp
            }
          })
        }), { isolationLevel: 'RepeatableRead' }
      )
    } catch (e: any) {
      throw new Error(`updateRankTransactions: ${e.message}`)
    }
  }
  /**
   * 
   * @param height 
   * @returns 
   */
  async getRankTransactionsByHeight(
    height: number
  ): Promise<RankTransaction[]> {
    try {
      return await this.db.rankTransaction.findMany({ where: { height }})
    } catch (e: any) {
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
        where: { height }
      })
    } catch (e: any) {
      throw new Error(`getBlockByHeight: ${e.message}`)
    }
  }
  /**
   * Delete a `RankTransaction`. Useful for `TransactionRemovedFromMempool` events.
   * @param txid 
   * @returns {Promise<Prisma.BatchPayload | false>}
   */
  async deleteRankTransactionsByTxid(
    txid: string
  ): Promise<undefined> {
    try {
      await this.db.rankTransaction.deleteMany({
        where: { txid }
      })
    } catch (e: any) {
      // not a critical error
      console.error(`WARN: deleteRankTransactionsByTxid: ${e.message}`)
    }
  }
  /**
   * 
   * @param height 
   */
  async deleteBlockByHeight(height: number) {
    try {
      await this.db.block.delete({
        where: { height }
      })
    } catch (e: any) {
      throw new Error(`deleteBlockByHeight: ${e.message}`)
    }
  }
  async saveBlock(block: Block) {
    try {
      await this.db.block.create({
        data: block
      })
    } catch (e: any) {
      throw new Error(`saveBlock: ${e.message}`)
    }
  }
  /**
   * Save several blocks; primarily useful during `syncBlocks()`
   * @param blocks 
   */
  async saveBlocks(
    blocks: Block[]
  ) {
    try {
      await this.db.block.createMany({
        data: blocks
      })
    } catch (e: any) {
      throw new Error(`saveBlocks: ${e.message}`)
    }
  }
  /**
   * 
   * @returns 
   */
  async getCheckpoint(): Promise<Block> {
    try {
      return await this.db.block.findFirst({
        orderBy: { height: "desc" },
        
      })
    } catch (e: any) {
      throw new Error(`getCheckpoint: ${e.message}`)
    }
  }

}