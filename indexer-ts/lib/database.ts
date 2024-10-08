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
   * Checks for existing `profileId` and returns the `accountId` of profile
   * @param profileId 
   * @returns 
   */
  async isExistingProfile(
    id: string
  ): Promise<string> {
    try {
      const result = await this.db.profile.findFirst({
        where: { id },
        include: { account: {
          select: { id: true }
        } },
      })
      return result?.account.id
    } catch (e: any) {
      throw new Error(`isExistingProfile: ${e.message}`)
    }
  }
  async isExistingTransaction(txid: string) {
    try {
      const result = await this.db.rankTransaction.findFirst({
        where: { output: { contains: txid }},
        select: { output: true }
      })
      return result?.output ?? undefined
    } catch (e: any) {

    }
  }
  /**
   * 
   * @param profiles 
   * @returns 
   */
  async rewindProfiles(profiles: Profile[]) {
    try {
      await this.db.$transaction(
        profiles.map(p => this.db.profile.update({
          where: { id: p.id, platform: p.platform },
          data: {
            ranks: {
              // For REORG processing
              deleteMany: {
                output: {
                  in: p.ranks.map(r => r.output)
                }
              }
            },
            ranking: {
              decrement: p.ranks.reduce((total, { sentiment, value }) => total + Number(sentiment ? value : -value), 0)
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
   * @param param0 
   */
  async upsertProfiles(profiles: Profile[]): Promise<undefined> {
    try {
      await this.db.$transaction(
        profiles.map(profile => {
          const { id, ranks } = profile
          const ranking = ranks.reduce((total, { sentiment, value }) => total + Number(sentiment ? value : -value), 0)
          return this.db.profile.upsert({
            where: { id },
            create: {
              ...profile,
              account: { create: { id: randomUUID() }},
              ranks: {
                createMany: {
                  data: ranks
                }
              },
              ranking
            },
            update: {
              ranks: {
                createMany: {
                  data: ranks
                }
              },
              ranking: {
                increment: ranking
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
          const { height, timestamp, output } = rank
          return this.db.rankTransaction.update({
            where: { output },
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
  ) {
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
        where: { output: { contains: txid }}
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