import { PrismaClient } from "@prisma/client";
import type {
  Checkpoint,
  RankTransaction,
  Profile
} from './node'
import * as constants from '../util/constants'

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

  async createAccount(
    data: Profile
  ): Promise<string | undefined> {
    try {
      const result = await this.db.account.create({
        data: { profiles: { create: data }}
      })
      return result?.id
    } catch (e: any) {
      throw new Error(`createProfile: ${e.message}`)
    }
  }

  async saveRankTransactions(
    data: RankTransaction[]
  ): Promise<number> {
    try {
      const result = await this.db.rankTransaction.createMany({
        data,
        skipDuplicates: true
      })
      return result.count
    } catch (e: any) {
      throw new Error(`saveRankTransactions: ${e.message}`)
    }
  }

  async saveCheckpoint(
    checkpoint: Checkpoint
  ) {
    try {
      await this.db.checkpoint.upsert({
        where: { id: 'main' },
        create: checkpoint,
        update: checkpoint
      })
    } catch (e: any) {
      throw new Error(`saveCheckpoint: ${e.message}`)
    }
  }

  async getCheckpoint() {
    try {
      return await this.db.checkpoint.findFirst()
    } catch (e: any) {
      throw new Error(`getCheckpoint: ${e.message}`)
    }
  }

}