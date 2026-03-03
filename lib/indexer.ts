import {
  BufferUtil,
  Opcode,
  Output,
  Script,
  Transaction,
} from 'xpi-ts/lib/bitcore'
import type { ByteBuffer } from 'flatbuffers'
//import { isIP } from 'validator'
//import { resolve } from 'node:path/posix'
//import { Worker } from 'node:worker_threads'
import { EventEmitter } from 'events'
import { RuntimeState } from './state'
import {
  SubscriptionManager,
  Topic,
  TopicCategoryWallet,
  TopicCategoryStewardship,
  TopicCategorySystem,
  TopicCategorySocial,
  PushNotification,
} from './push'
import { Database } from './database'
import { Temporal } from './temporal'
import { FAUCET_MILESTONE_VOTES, FAUCET_DRIP_AMOUNTS } from '../util/constants'
import type {
  ScriptChunkLokadUTF8,
  ScriptChunkSentimentUTF8,
  ScriptChunkPlatformUTF8,
} from 'xpi-ts/lib/rank'
import { ScriptProcessor } from 'xpi-ts/lib/rank'
import { isOpReturn } from 'xpi-ts/lib/rank/script'
import {
  RANK_OUTPUT_MIN_VALID_SATS,
  MAX_OP_RETURN_OUTPUTS,
} from 'xpi-ts/utils/constants'
import {
  NNG,
  NNG_RPC_BLOCKRANGE_SIZE,
  type Block,
  type NNGMessageType,
  type NNGMessageProcessor,
} from 'lotus-nng-client'
import * as NNGInterface from 'lotus-nng-client/lib/nng-interface'
import { ERR } from '../util/constants'
import { log, type LogEntry } from '../util/functions'
import config from '../config'
import type { Buffer } from 'buffer/'

/**
 * Output data specific to RANK transactions
 * Contains sentiment and target information for ranking votes
 */
export interface TransactionOutputRANK {
  /** The sentiment of the vote (positive or negative) */
  sentiment: ScriptChunkSentimentUTF8
  /** The platform where the target entity exists */
  platform: ScriptChunkPlatformUTF8
  /** The profile ID being voted on */
  profileId: string
  /** Optional post ID if voting on a specific post */
  postId?: string
}

/**
 * Output data specific to RNKC (Rank Comment) transactions
 * Contains comment data and reply target information
 */
export interface TransactionOutputRNKC {
  /** The comment data as raw bytes */
  data: Uint8Array
  /** The fee rate for the transaction */
  feeRate: number
  /** The platform of the entity being replied to */
  inReplyToPlatform: ScriptChunkPlatformUTF8
  /** The profile ID being replied to */
  inReplyToProfileId?: string
  /** The post ID being replied to */
  inReplyToPostId?: string
}

/**
 * Base indexed transaction data common to all LOKAD transactions
 * Contains blockchain-specific metadata
 */
export interface IndexedTransaction {
  /** The transaction ID */
  txid: string
  /** The output index within the transaction */
  outIdx: number
  /** The amount in satoshis */
  sats: bigint
  /** Unix timestamp (ms) when the transaction was first seen */
  firstSeen: bigint
  /** The script payload (voter's public key hash) */
  scriptPayload: string
  /** Optional instance ID for multi-instance deployments */
  instanceId?: string
  /** Block height if confirmed, undefined if in mempool */
  height?: number
  /** Block timestamp if confirmed */
  timestamp?: bigint
}

/**
 * Complete RANK transaction combining output data with indexed metadata
 */
export type TransactionRANK = TransactionOutputRANK & IndexedTransaction

/**
 * Complete RNKC transaction combining output data with indexed metadata
 */
export type TransactionRNKC = TransactionOutputRNKC & IndexedTransaction

/**
 * Base interface for entities that can be ranked (profiles and posts)
 * Contains ranking metrics and associated transactions
 */
export interface TargetEntity {
  /** Unique identifier for the entity */
  id: string
  /** Platform where the entity exists */
  platform: string
  /** Net ranking score (positive - negative sats) */
  ranking: bigint
  /** Array of RANK transactions targeting this entity */
  ranks: Omit<TransactionRANK, 'profileId' | 'platform'>[]
  /** Array of RNKC comments on this entity */
  comments: Omit<TransactionRNKC, 'inReplyToProfileId' | 'inReplyToPlatform'>[]
  /** Total positive satoshis received */
  satsPositive: bigint
  /** Total negative satoshis received */
  satsNegative: bigint
  /** Count of positive votes received */
  votesPositive: number
  /** Count of negative votes received */
  votesNegative: number
}

/**
 * Map of profile IDs to Profile objects
 * Used for batch processing and caching
 */
export type ProfileMap = Map<string, Profile>

/**
 * Map of post IDs to Post objects
 * Used for organizing posts within a profile
 */
export type PostMap = Map<string, Post>

/**
 * Represents a user profile that can be ranked
 * Extends TargetEntity with posts collection
 */
export interface Profile extends TargetEntity {
  /** Map of posts created by this profile */
  posts?: PostMap
}

/**
 * Represents a post that can be ranked
 * Extends TargetEntity with post-specific metadata
 */
export interface Post extends TargetEntity {
  /** The profile ID that created this post */
  profileId: string
  /** Optional post content data */
  data?: Uint8Array
  /** Unix timestamp (seconds) when the post was first voted on */
  firstVoted: bigint
  /** Unix timestamp (seconds) when the post was most recently voted on (for R64 temporal decay) */
  lastVoted: bigint
}
/**
 * Runtime cache for quickly reconciling missing LOKAD txs with blocks
 *
 * Key is `txid_outIdx`
 */
type MempoolCache = Map<string, MempoolCacheEntry>
/** Runtime index of mempool txids with their associated outpoints */
type MempoolTxidIndex = Map<string, string[]>
/**
 * Mempool cache entry
 *
 * This is a union of IndexedTransactionRANK and IndexedTransactionRNKC
 * with an additional type field to distinguish between the two.
 */
type MempoolCacheEntry = (TransactionRANK | TransactionRNKC) & {
  type: ScriptChunkLokadUTF8
}
/** Result of processing a single transaction */
type ProcessedTransaction = {
  ranks?: TransactionRANK[]
  rnkc?: TransactionRNKC
}
/**
 * Result of processing a block or mempool
 * */
type ProcessedBlockOrMempool = {
  ranks: TransactionRANK[]
  rnkcs: TransactionRNKC[]
}
/** Object containing primary key fields connecting saved transactions to blocks */
export type Outpoint = Pick<IndexedTransaction, 'txid' | 'outIdx'>
/**
 * Processes all transactions to find, parse, and index OP_RETURN outputs with
 * the `RANK` and `RNKC` LOKAD prefixes.
 *
 * Maintains a persistent connection to lotusd over the NNG interface. Subscribes
 * to the appropriate lotusd publishing endpoints and reacts to new messages
 * accordingly.
 */
export class Indexer extends EventEmitter {
  /** Database instance for storing indexed data */
  private db: Database
  /** NNG instance for communicating with lotusd */
  private nng!: NNG
  /** URI for the pub/sub socket connection */
  private pubUri: string
  /** URI for the RPC socket connection */
  private rpcUri: string
  /** Utilized during NNG events to notify subscribed instances of new activity */
  private subscriptionManager: SubscriptionManager
  /** Cache of unconfirmed RANK transactions */
  private mempool: MempoolCache
  /** Runtime index of mempool txids with their associated outpoints */
  private mempoolTxidIndex: MempoolTxidIndex
  /** Queue for upserting/rewinding profiles */
  private profileQueue: ProfileMap
  /** Runtime state used across modules */
  private state: RuntimeState
  /** Temporal instance for storing indexed data */
  private temporal: Temporal
  /**
   * Creates a new Indexer instance that connects to lotusd via NNG sockets
   * @param db Database instance for storing indexed data
   * @param pubUri Optional path to the NNG pub/sub socket (defaults to ~/.lotus/pub.pipe)
   * @param rpcUri Optional path to the NNG RPC socket (defaults to ~/.lotus/rpc.pipe)
   */
  constructor({
    state,
    db,
    temporal,
    subscriptionManager,
    pubUri,
    rpcUri,
  }: {
    state: RuntimeState
    db: Database
    temporal: Temporal
    subscriptionManager: SubscriptionManager
    pubUri?: string
    rpcUri?: string
  }) {
    super()
    // Validate NNG parameters
    this.pubUri = pubUri
    this.rpcUri = rpcUri
    // Module setup
    this.db = db
    this.state = state
    this.temporal = temporal
    this.subscriptionManager = subscriptionManager
    // Runtime state setup
    this.mempool = new Map()
    this.mempoolTxidIndex = new Map()
    this.profileQueue = new Map()
  }
  /**
   * Converts a Block or IndexedTransactionRANK object into an array of LogEntry tuples
   * @param data - The Block or IndexedTransactionRANK object to convert
   * @returns Array of [key, value] tuples representing the object's properties as strings
   */
  private toLogEntries(data: Block | TransactionRANK): LogEntry[] {
    return Object.entries(data).map(([k, v]) => [k, String(v)])
  }
  /**
   * Perform all required operations to initialize the indexer and sync with lotusd.
   * This includes:
   * - Establishing NNG socket connections to lotusd for RPC and pub/sub
   * - Cleaning up any unconfirmed transactions from the database
   * - Rewinding profile states for any unconfirmed transactions
   * - Reconciling the current block checkpoint with lotusd
   * - Initializing mempool tracking
   *
   * Throws errors if:
   * - NNG connections fail to establish
   * - Profile rewind operations fail
   * - Checkpoint reconciliation fails
   */
  async init() {
    /**
     * Initialize Modules
     * - NNG RPC socket for communicating with lotusd
     * - NNG Pub/Sub socket for receiving block/tx notifications
     * - Database cleanup of unconfirmed transactions
     * - Block checkpoint reconciliation with lotusd
     */
    // TODO: Need to actually detect NNG connectivity...
    this.nng = new NNG({
      sockets: [
        { type: 'sub', path: this.pubUri },
        { type: 'req', path: this.rpcUri },
      ],
      processors: {
        mempooltxadd: this.nngMempoolTxAdd,
        mempooltxrem: this.nngMempoolTxRemove,
        blkconnected: this.nngBlockConnected,
        blkdisconctd: this.nngBlockDisconnected,
      },
    })
    log([
      ['init', 'nng'],
      ['status', 'connected'],
      ['rpcUri', `"${this.rpcUri}"`],
      ['pubUri', `"${this.pubUri}"`],
    ])
    /**
     *    Cleanup
     */
    // rewind all unconfirmed state from the database
    try {
      const t0 = performance.now()
      const ranks = await this.db.getRankTransactionsByHeight(null)
      const rnkcs = await this.db.getRankCommentsByHeight(null)
      ranks.forEach(this.addRankTransactionToProfileQueue)
      rnkcs.forEach(this.addRankCommentToProfileQueue)
      if (this.profileQueue.size > 0) {
        await this.db.rewindProfiles(this.profileQueue)
        this.profileQueue.clear()
        const t1 = (performance.now() - t0).toFixed(3)
        log([
          ['init', 'cleanup'],
          ['ranksLength', `${ranks.length}`],
          ['rnkcsLength', `${rnkcs.length}`],
          ['action', 'rewindProfiles'],
          ['elapsed', `${t1}ms`],
        ])
      }
    } catch (e) {
      throw [ERR.IDX_PROFILE_REWIND, e.message]
    }
    /**
     *    Reconcile Checkpoint
     */
    let checkpoint: Block
    try {
      // Get current checkpoint from DB
      const dbCheckpoint = await this.db.getCheckpoint()
      // reconcile our checkpoint with the blockchain state
      // if we don't have a checkpoint, use the configured RANK genesis block
      checkpoint = await this.initReconcileBlockState(
        dbCheckpoint ?? (config.genesis as Block),
      )
    } catch (e) {
      throw [ERR.IDX_BLOCKS_REWIND, e.message]
    }
    // Log our current checkpoint (i.e. best block)
    log([['init', 'best'], ...this.toLogEntries(checkpoint)])
    // Sync blocks
    try {
      this.state.checkpoint = await this.initSyncBlocks(checkpoint)
    } catch (e) {
      throw [ERR.IDX_BLOCKS_SYNC, e.message]
    }

    // Sync mempool
    try {
      const results = await this.initSyncMempool()
      // Initialize the mempool cache and index with these RANK txs
      results.ranks.forEach(rank => {
        const key = `${rank.txid}_${rank.outIdx}`
        const outpoints = this.mempoolTxidIndex.get(rank.txid)
        if (outpoints) {
          outpoints.push(key)
        } else {
          this.mempoolTxidIndex.set(rank.txid, [key])
        }
        this.mempool.set(key, {
          ...rank,
          type: 'RANK',
        })
      })
      // Initialize the mempool cache and index with these RNKC txs
      results.rnkcs.forEach(rnkc => {
        const key = `${rnkc.txid}_${rnkc.outIdx}`
        const outpoints = this.mempoolTxidIndex.get(rnkc.txid)
        if (outpoints) {
          outpoints.push(key)
        } else {
          this.mempoolTxidIndex.set(rnkc.txid, [key])
        }
        this.mempool.set(key, {
          ...rnkc,
          type: 'RNKC',
        })
      })
    } catch (e) {
      throw [ERR.IDX_MEMPOOL_SYNC, e.message]
    }
    // Subscribe to required NNG channels
    const channels: NNGMessageType[] = [
      'mempooltxadd',
      'mempooltxrem',
      'blkconnected',
      'blkdisconctd',
    ]
    this.nng.subscribe('sub', channels)
    log([
      ['init', 'nng'],
      ['status', 'subscribed'],
      ['channels', channels.join(',')],
    ])
  }
  /**
   * Reconciles the local checkpoint block with the lotusd blockchain state and rewinds database if needed.
   * Ensures database state matches the blockchain by comparing block hashes at each height and rewinding
   * if a mismatch is found.
   * @param {Block} checkpoint - The current checkpoint block to reconcile, either from DB or genesis
   * @returns {Promise<Block>} The reconciled checkpoint block that matches lotusd state
   * @throws {[ERR.IDX_BLOCKS_REWIND, string]} If error occurs during reconciliation
   */
  async initReconcileBlockState(checkpoint: Block): Promise<Block> {
    // Get the best block compared to our checkpoint
    // The best block will be the checkpoint that matches lotusd, at whichever height this is true
    const best = await this.getBestBlock(checkpoint)
    // Return checkpoint if conditions do not require rewinding database state
    if (
      // checkpoint hash is best block tip at best height
      (checkpoint.hash == best.hash && best.height == checkpoint.height) ||
      // checkpoint hash is previous best block tip and was extended by best block tip
      (checkpoint.hash == best.prevhash &&
        best.height == checkpoint.height + 1) ||
      // best block tip is 2+ blocks ahead
      best.height > checkpoint.height + 1
    ) {
      return checkpoint
    }
    log([['init', 'newBest'], ...this.toLogEntries(best)])
    // rewind backwards to match checkpoint height/hash to RPC
    for (let height = checkpoint.height; height > best.height; height--) {
      const t0 = performance.now()
      const txsLength = await this.rewindBlock(height)
      const t1 = (performance.now() - t0).toFixed(3)
      log([
        ['init', 'reorg'],
        ['height', `${height}`],
        ['txsLength', `${txsLength}`],
        ['action', 'rewindBlock'],
        ['elapsed', `${t1}ms`],
      ])
    }
    // Return the best block as new checkpoint
    return best
  }
  /**
   * Synchronizes database state with lotusd blockchain by processing blocks in batches, starting from the current checkpoint.
   * Fetches and processes blocks in ranges until caught up with the chain tip.
   * @returns {Promise<void>} Resolves when sync is complete
   * @throws {[ERR.IDX_BLOCKS_SYNC, string]} If error occurs during block sync
   * @property {number} totalBlocks - Total number of blocks processed during sync
   * @property {number} totalRanks - Total number of rank updates processed during sync
   * @property {Block} checkpoint - The latest processed block checkpoint
   * @property {number} NNG_RPC_BLOCKRANGE_SIZE - Number of blocks to fetch in each batch
   */
  async initSyncBlocks(checkpoint: Block): Promise<Block> {
    let totalBlocks = 0,
      totalRanks = 0,
      totalComments = 0
    const t0 = performance.now()
    while (true) {
      const startHeight = checkpoint.height + 1
      const t0 = performance.now()
      const blockrange = await this.nng.rpcGetBlockRange(
        startHeight,
        NNG_RPC_BLOCKRANGE_SIZE,
      )
      const blocksLength = blockrange.blocksLength()
      // no blocks if we are now synced
      if (blocksLength < 1) {
        break
      }
      // Save the blockrange we have
      let ranksLength: number
      let rnkcsLength: number
      ;[checkpoint, ranksLength, rnkcsLength] = await this.saveBlockRange(
        blockrange,
        blocksLength,
      )
      totalBlocks += blocksLength
      totalRanks += ranksLength
      totalComments += rnkcsLength
      const t1 = (performance.now() - t0).toFixed(3)
      log([
        ['init', 'syncBlocks'],
        ['status', 'running'],
        ['startHeight', `${startHeight}`],
        ['endHeight', `${checkpoint.height}`],
        [`ranksLength`, `${ranksLength}`],
        [`rnkcsLength`, `${rnkcsLength}`],
        ['elapsed', `${t1}ms`],
      ])
      // If we didn't sync full block range, we are now synced
      if (blocksLength < NNG_RPC_BLOCKRANGE_SIZE) {
        break
      }
    }
    const t1 = ((performance.now() - t0) / 1000).toFixed(3)
    log([
      ['init', 'syncBlocks'],
      ['status', 'finished'],
      ['totalBlocks', `${totalBlocks}`],
      ['totalRanks', `${totalRanks}`],
      ['totalComments', `${totalComments}`],
      ['elapsed', `${t1}s`],
    ])
    // return the latest checkpoint block
    return checkpoint
  }
  /**
   * Synchronizes database state with the current lotusd mempool by fetching and processing unconfirmed transactions
   * @returns {Promise<IndexedTransactionRANK[]>} Array of RANK transactions currently in mempool
   * @property {number} txsLength - Number of transactions in mempool
   * @property {number} ranksLength - Number of RANK transactions processed
   * @property {number} elapsed - Time taken to sync mempool in milliseconds
   */
  async initSyncMempool(): Promise<ProcessedBlockOrMempool> {
    const t0 = performance.now()
    const entries: LogEntry[] = [['init', 'syncMempool']]
    const mempool = await this.nng.rpcGetMempool()
    const txsLength = mempool.txsLength()
    entries.push(['txsLength', `${txsLength}`])
    const results = this.processBlockOrMempool(mempool)
    results.ranks.forEach(this.addRankTransactionToProfileQueue)
    results.rnkcs.forEach(this.addRankCommentToProfileQueue)
    if (this.profileQueue.size > 0) {
      try {
        await this.db.upsertProfiles(this.profileQueue)
        this.profileQueue.clear()
      } catch (e) {
        throw new Error(
          `db.upsertProfiles(${typeof this.profileQueue}): ${e.message}`,
        )
      }
    }
    const t1 = (performance.now() - t0).toFixed(3)
    entries.push(
      ['ranksLength', `${results.ranks.length}`],
      ['rnkcsLength', `${results.rnkcs.length}`],
      ['action', 'upsertProfiles'],
      ['elapsed', `${t1}ms`],
    )
    log(entries)
    // Return the RANK txs currently in mempool
    return results
  }
  /**
   * Cleanly shuts down all network connections and closes the indexer
   * @returns {Promise<void>} Resolves when all connections are closed
   */
  async close(): Promise<void> {
    this.nng.close()
  }
  /**
   * Compare checkpoint `Block` against the RPC counterpart. Recurse backwards until a match is found.
   * @param checkpoint `Block` whose hash is compared to RPC at the same `height`
   * @returns {Promise<Block>} The best `Block` required to fully sync with RPC
   */
  private async getBestBlock(checkpoint: Block): Promise<Block> {
    try {
      // nanomsg library will block if there is a connection issue
      // nanomsg library will return if RPC responds
      const best = await this.nng.rpcGetBlock(checkpoint.height)
      // block will be null if RPC didn't give us the block for the checkpoint height
      if (best) {
        const block = this.toBlock(best.header(), true)
        if (block.hash == checkpoint.hash) {
          // return RPC block (with prevhash) as best
          return block
        }
      }
      // Either we didn't get a block from RPC or hash mismatch
      // Get the prevblock from database and recurse
      const prevblock = await this.db.getBlockByHeight(checkpoint.height - 1)
      return this.getBestBlock(prevblock)
    } catch (e) {
      throw new Error(`getBestBlock(${typeof checkpoint}): ${e.message}`)
    }
  }
  /**
   * Process the range of `NNGInterface.Block` objects for RANK tranactions and save all `Block`s as checkpoints
   * @param blockrange `NNGInterface.GetBlockRangeResponse` object providing array of `NNGInterface.Block`
   * @param blocksLength Length of `NNGInterface.Block` array
   * @returns {Promise<[ Block, number ]>}
   * Tuple containing latest `Block` as new checkpoint and `number` of RANK txs in the `blockrange`
   */
  private async saveBlockRange(
    blockrange: NNGInterface.GetBlockRangeResponse,
    blocksLength: number,
  ): Promise<[Block, number, number]> {
    const blocks: Block[] = []
    const ranks: TransactionRANK[] = []
    const rnkcs: TransactionRNKC[] = []
    for (let i = 0; i < blocksLength; i++) {
      try {
        const block = blockrange.blocks(i)
        const checkpoint = this.toBlock(block.header())
        const txsLength = block.txsLength()
        // Skip processing blocks with only coinbase tx or none at all
        if (txsLength <= 1) {
          // Keep block to update database checkpoint
          blocks.push(checkpoint)
          continue
        }
        const results = this.processBlockOrMempool(block)
        // Saving these for later
        blocks.push({ ...checkpoint, ranksLength: results.ranks.length })
        ranks.push(...results.ranks)
        rnkcs.push(...results.rnkcs)
      } catch (e) {
        throw new Error(
          `saveBlockRange(${typeof blockrange}, ${blocksLength}): ${e.message}`,
        )
      }
    }
    // Process any available LOKAD transactions into the profile queue
    ranks.forEach(this.addRankTransactionToProfileQueue)
    // Process any available RNKC transactions into the profile queue
    rnkcs.forEach(this.addRankCommentToProfileQueue)
    // Save blocks and Profile upserts in one atomic database transaction
    try {
      await this.db.saveBlockRange(blocks, this.profileQueue)
      this.profileQueue.clear()
    } catch (e) {
      throw new Error(
        `db.saveBlockRange(${typeof blocks}, ${typeof this.profileQueue}): ${e.message}`,
      )
    }
    // Return the latest block as the new checkpoint block
    // Also return the number of RANK txs and RNKC txs processed
    return [blocks.pop(), ranks.length, rnkcs.length]
  }
  /**
   * Rewind the database state created at `height`
   * @param height `height` parsed from `NNGInterface.BlockHeader`
   * @returns Number of `IndexedTransactionRANK`s removed from database
   */
  private async rewindBlock(height: number): Promise<number> {
    try {
      // Fetch RANK/RNKC txs at height and add profiles to queue for rewind
      const ranks = await this.db.getRankTransactionsByHeight(height)
      const rnkcs = await this.db.getRankCommentsByHeight(height)
      ranks.forEach(this.addRankTransactionToProfileQueue)
      rnkcs.forEach(this.addRankCommentToProfileQueue)
      // Execute rewind statements if necessary
      if (this.profileQueue.size > 0) {
        await this.db.rewindProfiles(this.profileQueue)
        this.profileQueue.clear()
      }
      await this.db.deleteBlockByHeight(height)
      return ranks.length
    } catch (e) {
      throw new Error(`rewindBlock(${height}: ${e.message}`)
    }
  }
  /**
   * Process NNG `mempooltxadd` messages
   * @param bb `ByteBuffer` data published by lotusd
   * @returns {Promise<void>}
   */
  private nngMempoolTxAdd: NNGMessageProcessor = async (
    bb: ByteBuffer,
  ): Promise<void> => {
    const t0 = performance.now()
    const mempooltx =
      NNGInterface.TransactionAddedToMempool.getRootAsTransactionAddedToMempool(
        bb,
      ).mempoolTx()
    const nngTx = mempooltx.tx()
    const rawArray = nngTx.rawArray()
    const tx = new Transaction(BufferUtil.from(rawArray))
    // Process the transaction using the processTransaction function
    // block is null for mempool transactions
    const processed = this.processTransaction(tx, nngTx, null)
    // Add RANK transactions to mempool cache for reconciliation
    // Also add profiles to queue for upserting
    if (processed.ranks) {
      processed.ranks.forEach(rank => {
        const outpoints = this.mempoolTxidIndex.get(rank.txid)
        if (outpoints) {
          outpoints.push(`${rank.txid}_${rank.outIdx}`)
        } else {
          this.mempoolTxidIndex.set(rank.txid, [`${rank.txid}_${rank.outIdx}`])
        }
        this.mempool.set(`${rank.txid}_${rank.outIdx}`, {
          ...rank,
          type: 'RANK',
        })
        this.addRankTransactionToProfileQueue(rank)
      })
    }
    // Add RNKC tx to mempool cache for reconciliation
    // Also add profiles to queue for upserting
    if (processed.rnkc) {
      const outpoints = this.mempoolTxidIndex.get(processed.rnkc.txid)
      if (outpoints) {
        outpoints.push(`${processed.rnkc.txid}_${processed.rnkc.outIdx}`)
      } else {
        this.mempoolTxidIndex.set(processed.rnkc.txid, [
          `${processed.rnkc.txid}_${processed.rnkc.outIdx}`,
        ])
      }
      this.mempool.set(`${processed.rnkc.txid}_${processed.rnkc.outIdx}`, {
        ...processed.rnkc,
        type: 'RNKC',
      })
      this.addRankCommentToProfileQueue(processed.rnkc)
    }
    // Upsert profiles to database and clear profile queue
    if (this.profileQueue.size > 0) {
      try {
        // Upsert profiles to database and clear profile queue
        await this.db.upsertProfiles(this.profileQueue)
        // TODO: move this to the RANK/RNKC processing
        // Or, add more metadata to the `Profile`/`Post` objects so
        // that we can send informational notifications
        //for (const [profileId, profile] of this.profileQueue) {
        //  this.subscriptionManager.queueNotification({
        //    topics: [],
        //    message: {
        //      title: 'New RANK transaction',
        //      body: `New RANK transaction: ${tx.txid}`,
        //    },
        //  })
        //}
        this.profileQueue.clear()
        // Check faucet milestones for each distinct voter in this tx
        if (processed.ranks?.length > 0) {
          const voterPayloads = processed.ranks.map(r => r.scriptPayload)
          for (const scriptPayload of voterPayloads) {
            this.checkFaucetMilestone(scriptPayload).catch(e => {
              log([
                ['nng', 'warn'],
                ['action', 'checkFaucetMilestone'],
                ['scriptPayload', scriptPayload],
                ['message', `"${String(e)}"`],
              ])
            })
          }
        }
        const t1 = (performance.now() - t0).toFixed(3)
        log([
          ['nng', 'mempooltxadd'],
          ['txid', tx.txid],
          ['ranksLength', `${processed.ranks.length}`],
          ['isComment', `${!!processed.rnkc}`],
          ['action', 'upsertProfiles'],
          ['elapsed', `${t1}ms`],
        ])
      } catch (e) {
        throw new Error(
          `db.upsertProfiles(${typeof this.profileQueue}): ${e.message}`,
        )
      }
    }
  }
  /**
   * Process NNG `mempooltxrem` messages
   * @param bb `ByteBuffer` data published by lotusd
   * @returns {Promise<void>}
   */
  private nngMempoolTxRemove: NNGMessageProcessor = async (
    bb: ByteBuffer,
  ): Promise<void> => {
    const t0 = performance.now()
    const tx =
      NNGInterface.TransactionRemovedFromMempool.getRootAsTransactionRemovedFromMempool(
        bb,
      )
    const txid = this.toBlockhashOrTxid(tx.txid().hash())

    // O(1) lookup using mempoolTxidIndex instead of O(n) scan
    const keysToDelete = this.mempoolTxidIndex.get(txid) ?? []
    const txs: MempoolCacheEntry[] = []

    // Fetch entries and delete from main cache
    for (const key of keysToDelete) {
      const entry = this.mempool.get(key)
      if (entry) {
        txs.push(entry)
        this.mempool.delete(key)
      }
    }

    // Clean up the index entry
    this.mempoolTxidIndex.delete(txid)

    // Convert RANK txs to profiles and add to queue for rewind
    txs.forEach(tx => {
      switch (tx.type) {
        case 'RANK':
          this.addRankTransactionToProfileQueue(tx as TransactionRANK)
          break
        case 'RNKC':
          this.addRankCommentToProfileQueue(tx as TransactionRNKC)
          break
      }
    })
    // Execute rewind statements if necessary
    if (this.profileQueue.size > 0) {
      await this.db.rewindProfiles(this.profileQueue)
      this.profileQueue.clear()
      const t1 = (performance.now() - t0).toFixed(3)

      // Remove all txs from mempool cache
      keysToDelete.forEach(key => this.mempool.delete(key))

      // Log the result
      log([
        ['nng', 'mempooltxrem'],
        ['txid', txid],
        ['outpointsLength', `${txs.length}`],
        ['action', 'rewindProfiles'],
        ['elapsed', `${t1}ms`],
      ])
    }
  }
  /**
   * Process NNG `blkconnected` messages
   * @param bb `ByteBuffer` data published by lotusd
   * @returns {Promise<void>}
   */
  private nngBlockConnected: NNGMessageProcessor = async (
    bb: ByteBuffer,
  ): Promise<void> => {
    const entries: LogEntry[] = [['nng', 'blkconnected']]
    const t0 = performance.now()
    const connectedBlock =
      NNGInterface.BlockConnected.getRootAsBlockConnected(bb)
    // Get the NNG block and convert header to database `Block` entry
    const block = connectedBlock.block()
    const best = this.toBlock(block.header())
    // Process block for any RANK txs
    const results = this.processBlockOrMempool(block)
    best.ranksLength = results.ranks.length
    best.rnkcsLength = results.rnkcs.length
    entries.push(...this.toLogEntries(best))
    // Reconcile mempool cache with block transactions
    // Outpoints are used to connect existing transactions to the new block
    const outpointsRANK: Outpoint[] = []
    const outpointsRNKC: Outpoint[] = []
    // Find any RANK txs that were missing from mempool cache (i.e. not already upserted)
    if (results.ranks.length > 0) {
      const { outpoints, missing } = await this.reconcileMempoolCache(
        results.ranks,
      )
      outpointsRANK.push(...outpoints)
      if (missing.length > 0) {
        missing.forEach(this.addRankTransactionToProfileQueue)
      }
    }
    if (results.rnkcs.length > 0) {
      const { outpoints, missing } = await this.reconcileMempoolCache(
        results.rnkcs,
      )
      outpointsRNKC.push(...outpoints)
      // Find any RNKC txs that were missing from mempool cache (i.e. not already upserted)
      if (missing.length > 0) {
        missing.forEach(this.addRankCommentToProfileQueue)
      }
    }
    // Save latest checkpoint plus any missing RANK txs
    await this.db.saveBlock(
      best,
      { ranks: outpointsRANK, rnkcs: outpointsRNKC },
      this.profileQueue,
    )
    this.profileQueue.clear()
    const t1 = (performance.now() - t0).toFixed(3)
    entries.push(['action', 'saveBlock'], ['elapsed', `${t1}ms`])
    // TODO: we may need to add some additional state checks here, but maybe not

    // Update state with this checkpoint block
    this.state.checkpoint = { ...best }
    // Log the result
    log(entries)
  }
  /**
   * Process NNG `blkdisconctd` messages
   * @param bb `ByteBuffer` data published by lotusd
   * @returns {Promise<void>}
   */
  private nngBlockDisconnected: NNGMessageProcessor = async (
    bb: ByteBuffer,
  ): Promise<void> => {
    const t0 = performance.now()
    const disconnectedBlock =
      NNGInterface.BlockDisconnected.getRootAsBlockDisconnected(bb).block()
    const block = this.toBlock(disconnectedBlock.header())
    // Rewind the disconnected block
    const txsLength = await this.rewindBlock(block.height)
    const t1 = (performance.now() - t0).toFixed(3)
    // Get the latest checkpoint block from the database
    this.state.checkpoint = await this.db.getCheckpoint()
    // Log the result
    log([
      ['nng', 'blkdisconctd'],
      ...this.toLogEntries(block),
      ['txsLength', `${txsLength}`],
      ['action', 'rewindBlock'],
      ['elapsed', `${t1}ms`],
    ])
  }
  /**
   * Process transactions from a block or mempool to extract RANK transactions
   * @param data Block or mempool data containing transactions to process
   * @returns Array of parsed RANK transactions with metadata
   */
  private processBlockOrMempool(
    data: NNGInterface.Block | NNGInterface.GetMempoolResponse,
  ): ProcessedBlockOrMempool {
    const results: ProcessedBlockOrMempool = {
      ranks: [],
      rnkcs: [],
    }
    const txsLength = data.txsLength()
    // `block` is null if processing mempool txs, otherwise it's the block header
    const block =
      data instanceof NNGInterface.Block ? this.toBlock(data.header()) : null
    const startIndex = block ? 1 : 0
    // skip coinbase tx if processing block data
    for (let i = startIndex; i < txsLength; i++) {
      try {
        const nngTx = data.txs(i).tx()
        const rawArray = nngTx.rawArray()
        // Convert Uint8Array to Buffer else bitcore parse will fail
        const tx = new Transaction(BufferUtil.from(rawArray))
        // Process the transaction as either block or mempool tx
        const processed = this.processTransaction(tx, nngTx, block)
        if (processed.ranks) {
          results.ranks.push(...processed.ranks)
        }
        if (processed.rnkc) {
          results.rnkcs.push(processed.rnkc)
        }
      } catch (e) {
        throw new Error(
          `processBlockOrMempool(${block?.height ?? 'mempool'}): ${e.message}`,
        )
      }
    }
    return results
  }
  /**
   * Process a single transaction to extract compatible LOKAD protocols
   * @param tx `Transaction` object
   * @param nngTx `NNGInterface.Tx` object containing spent_coins data for Taproot support
   * @param block `Block` object, if available
   * @returns {void}
   */
  private processTransaction(
    tx: Transaction,
    nngTx: NNGInterface.Tx,
    block: Block | null,
  ): ProcessedTransaction {
    // Set up return object
    const result: ProcessedTransaction = {
      ranks: [],
      rnkc: null,
    }
    // Extract spent_coins array from NNG Tx for Taproot support
    const spentCoins: NNGInterface.Coin[] = []
    const spentCoinsLength = nngTx.spentCoinsLength()
    if (spentCoinsLength > 0) {
      for (let i = 0; i < spentCoinsLength; i++) {
        const coin = nngTx.spentCoins(i)
        if (coin) {
          spentCoins.push(coin)
        }
      }
    }
    // Get script payload for the transaction (now supports P2TR via spent_coins)
    const scriptPayload = this.getScriptPayload(tx, spentCoins)
    // Return early if script payload could not be extracted (invalid input script format)
    if (!scriptPayload) {
      return result
    }
    // Get the ScriptProcessor for the first output
    // Several validations are done here, including:
    // - checking if the output is OP_RETURN
    // - checking if the output has a valid LOKAD protocol
    const scriptProcessor = this.validateOutputScript(
      tx.outputs[0].script.toBuffer(),
    )
    if (!scriptProcessor) {
      return result
    }

    // Get the first seen timestamp, updated later for additional outputs
    let firstSeen = BigInt(Date.now())
    // Process the transaction based on the LOKAD protocol
    switch (scriptProcessor.lokadType) {
      // RankTransaction model
      case 'RANK': {
        // If the first output has a value less than the minimum required
        // for a valid RANK output, return current result object
        if (tx.outputs[0].satoshis < RANK_OUTPUT_MIN_VALID_SATS) {
          return result
        }
        // process the first RANK output
        const rank = scriptProcessor.processScriptRANK()
        if (!rank) {
          return result
        }
        result.ranks.push({
          txid: tx.txid,
          outIdx: 0,
          firstSeen: firstSeen++,
          scriptPayload,
          height: block?.height, // undefined if mempool tx
          sats: BigInt(tx.outputs[0].satoshis),
          timestamp: block?.timestamp, // undefined until block is connected
          ...rank,
        })
        // outIdx 1 and 2 may be valid RANK outputs, so we process those here
        for (let i = 1; i < MAX_OP_RETURN_OUTPUTS; i++) {
          const output = tx.outputs[i]
          const scriptProcessor = this.validateOutputScript(
            output?.script?.toBuffer(),
          )
          // For any output that fails at this point, abandon the loop
          // and switch blocks to return the results we have
          if (!scriptProcessor) {
            break
          }

          // Only neutral sentiments are allowed to have zero value, any other sentiments
          // must have a non-zero value
          if (output.satoshis === 0) {
            // Try to process as a neutral RANK output and add to results if valid
            const neutralRank = this.processNeutralRANK(output)
            if (neutralRank) {
              result.ranks.push({
                txid: tx.txid,
                outIdx: i,
                firstSeen: firstSeen++,
                scriptPayload,
                height: block?.height, // undefined if mempool tx
                sats: BigInt(output.satoshis),
                timestamp: block?.timestamp, // undefined until block is connected
                ...neutralRank,
              })
              // continue to the next output
              continue
            }
          }
          // TODO: can add more checks for additional RANK scenarios here
          //
        }
        break
      }
      // RankComment model
      case 'RNKC': {
        // Add supplemental scripts to the ScriptProcessor
        // Maximum of 2 supplemental scripts (outIdx 1 and 2)
        for (const output of tx.outputs.slice(1, MAX_OP_RETURN_OUTPUTS)) {
          // if we can't add the next script, abandon the loop and process
          // the RNKC data we have so far
          if (!scriptProcessor.addScript(output.script.toBuffer())) {
            break
          }
        }
        const rnkc = scriptProcessor.processScriptRNKC(tx.outputs[0].satoshis)
        // If the RNKC is invalid, return current result object
        if (!rnkc) {
          return result
        }
        result.rnkc = {
          txid: tx.txid,
          outIdx: 0, // RNKC is always the first output
          firstSeen,
          scriptPayload,
          height: block?.height, // undefined if mempool tx
          sats: BigInt(tx.outputs[0].satoshis),
          timestamp: block?.timestamp, // undefined until block is connected
          ...rnkc,
        }
        break
      }
    }
    return result
  }
  /**
   * Create a `ScriptProcessor` object from a `Transaction.Output` object
   * @param output `Transaction.Output` object
   * @returns `ScriptProcessor` object or `null` if invalid
   */
  private validateOutputScript(
    script: Buffer | undefined,
  ): ScriptProcessor | null {
    if (!script) {
      return null
    }
    // Check if the output script is OP_RETURN
    if (!isOpReturn(script)) {
      return null
    }
    // Create a ScriptProcessor to validate the output script
    try {
      const processor = new ScriptProcessor(script)
      // TODO: add more validation here as needed
      //
      return processor
    } catch (e) {
      return null
    }
  }
  /**
   * Validate a `RANK` output that is OP_RETURN at outIdx 1 or 2
   *
   * These outputs are allowed to have zero value if the first output has a value
   * greater than the minimum required for a valid RANK output
   * @param output `Transaction.Output` object
   * @returns `TransactionOutputRANK` object or `null` if invalid
   */
  private processNeutralRANK(output: Output): TransactionOutputRANK | null {
    // Create a ScriptProcessor to validate the output script
    const processor = new ScriptProcessor(output.script.toBuffer())
    const rank = processor.processScriptRANK()
    if (!rank) {
      return null
    }
    // If the sentiment is not neutral, return null
    if (rank.sentiment !== 'neutral') {
      return null
    }
    return rank
  }
  /**
   * Filter the mempool of transactions that are in the provided array of block transactions
   * @param blockTxs `IndexedTransaction` objects (RANK, RNKC, etc.)
   * @returns Object containing array of `Outpoint`s to connect existing transactions to
   * the new block, and array of `IndexedTransaction` objects that were missing from the mempool
   */
  private async reconcileMempoolCache(
    blockTxs: IndexedTransaction[],
  ): Promise<{ outpoints: Outpoint[]; missing: IndexedTransaction[] }> {
    const outpoints: Outpoint[] = []
    const missing: IndexedTransaction[] = []
    for (const tx of blockTxs) {
      // Mempool contains this block tx, so delete it from cache
      if (this.mempool.delete(`${tx.txid}_${tx.outIdx}`)) {
        outpoints.push({ txid: tx.txid, outIdx: tx.outIdx })
        continue
      }
      // Mempool did not contain this tx, so add it to the missing list
      missing.push(tx)
    }
    return { outpoints, missing }
  }
  /**
   * Process `Transaction.Input` objects to get the `scriptPayload`
   * Only return the `scriptPayload` if all inputs are from the same address
   *
   * For P2TR (Taproot) inputs, extracts the scriptPayload from the previous
   * output's scriptPubKey provided via spent_coins data from NNG interface.
   * Lotus uses 33-byte compressed pubkeys for Taproot (not x-only 32-byte).
   * @param tx `Transaction` object
   * @param spentCoins Array of `Coin` objects from NNG Tx.spent_coins, containing prevout data
   * @returns `scriptPayload` as a hex string or `null` if inputs are invalid
   */
  private getScriptPayload(
    tx: Transaction,
    spentCoins: NNGInterface.Coin[],
  ): string | null {
    // Handle Taproot (P2TR) inputs
    if (tx.inputs[0].script.isTaprootIn()) {
      // Taproot requires prevout data from spent_coins
      if (spentCoins.length === 0) {
        return null // Cannot process Taproot without prevout data
      }

      // Extract scriptPubKey from first input's prevout and convert to
      // bitcore Script object
      const firstCoin = spentCoins[0]
      const scriptPubKeyArray = firstCoin.txOut()?.scriptArray()
      if (!scriptPubKeyArray || scriptPubKeyArray.length < 2) {
        return null // Invalid scriptPubKey
      }
      const scriptPubKey = Script.fromBuffer(BufferUtil.from(scriptPubKeyArray))
      if (!scriptPubKey.isTaprootOut()) {
        return null // Not a valid Lotus P2TR scriptPubKey
      }

      // Extract 33-byte compressed pubkey commitment as scriptPayload
      const scriptPayloadBuffer = scriptPubKey.getPayload().payload

      // Verify all inputs spend from the same Taproot address
      if (
        tx.inputs.every((input, i) => {
          // Check input script type
          if (!input.script.isTaprootIn()) {
            return false // Mixed input types not allowed
          }
          // Check spent_coins availability
          if (i >= spentCoins.length) {
            return false // Missing spent_coins data for input
          }

          // Get the output scriptPubKey as a Uint8Array and convert it to a
          // bitcore Script object
          const coin = spentCoins[i]
          const scriptArray = coin.txOut()?.scriptArray()
          if (!scriptArray) {
            return false // coin txout is missing
          }
          const script = Script.fromBuffer(BufferUtil.from(scriptArray))

          // Validate scriptPubKey format and extract commitment
          if (!script.isTaprootOut()) {
            return false // Invalid P2TR scriptPubKey
          }

          return (
            // OK to coerce to Address here because we know it's a P2TR script
            scriptPayloadBuffer.compare(script.toAddress()!.hashBuffer) === 0
          )
        })
      ) {
        return scriptPayloadBuffer.toString('hex')
      }

      return null
    }

    // Handle P2PKH/P2SH inputs (existing logic)
    const scriptPayloadBuffer = tx.inputs[0].script.toAddress().hashBuffer
    if (
      tx.inputs.every(
        input =>
          scriptPayloadBuffer.compare(input.script.toAddress().hashBuffer) ===
          0,
      )
    ) {
      return scriptPayloadBuffer.toString('hex')
    }
    return null
  }
  /**
   * Parse raw `NNGInterface.Hash` flatbuffer for the 32-byte block hash or txid
   * @param hash Raw `NNGInterface.Hash`
   * @returns {string} Block hash or txid as hex string (little endian)
   */
  private toBlockhashOrTxid(hash: NNGInterface.Hash): string {
    return BufferUtil.from(
      hash.bb.bytes().subarray(hash.bb_pos, hash.bb_pos + 32),
    )
      .reverse() // reverse for little endian
      .toString('hex')
  }
  /**
   * Parse raw `NNGInterface.BlockHeader` flatbuffer for the nHeight
   * (https://lotusia.org/docs/specs/blockheader)
   * @param header Raw `NNGInterface.BlockHeader`
   * @returns {number} Block height as a number
   */
  private toBlockHeight(header: NNGInterface.BlockHeader): number {
    // header could be undefined if processing mempool tx from nng
    if (!header) {
      return undefined
    }
    const nHeight = header.rawArray().subarray(60, 64)
    return BufferUtil.from(nHeight).readUInt32LE(0)
  }
  /**
   * Convert `NNGInterface.BlockHeader` to `Block` object
   * @param header `NNGInterface.BlockHeader`
   * @param includePrevHash `boolean` to include previous block hash
   * @returns `Block` object
   */
  private toBlock(
    header: NNGInterface.BlockHeader,
    includePrevhash = false,
  ): Block {
    try {
      const height = this.toBlockHeight(header)
      const timestamp = header.timestamp()
      const hash = this.toBlockhashOrTxid(header.blockHash().hash())
      const block: Block = {
        hash,
        height,
        timestamp,
        ranksLength: 0,
        rnkcsLength: 0,
      }
      if (includePrevhash) {
        block.prevhash = this.toBlockhashOrTxid(header.prevBlockHash().hash())
      }
      return block
    } catch (e) {
      throw new Error(`toBlock(${header}, ${includePrevhash}): ${e.message}`)
    }
  }
  /**
   * Add a `RANK` transaction to the profile queue
   * @param rank `IndexedTransactionRANK` object
   * @returns `void`
   */
  private addRankTransactionToProfileQueue = (rank: TransactionRANK): void => {
    const profile = this.toProfileFromRANK(rank)
    this.profileQueue.set(profile.id, profile)
  }
  /**
   * Add a `RNKC` transaction to the profile queue if applicable
   * @param rnkc `IndexedTransactionRNKC` object
   * @returns `void`
   */
  private addRankCommentToProfileQueue = (rnkc: TransactionRNKC): void => {
    // Each RNKC is a Lotusia post from a profile, so we add it to the profile queue
    const profile = this.toProfileFromRNKC(rnkc)
    this.profileQueue.set(
      rnkc.scriptPayload, // scriptPayload is the profileId for Lotusia posts
      profile,
    )
    // Each RNKC is also a comment on a profile or post, so we add it to the replied
    // profile's queue as well
    const repliedProfile = this.toRepliedProfileFromRNKC(rnkc)
    if (repliedProfile) {
      this.profileQueue.set(repliedProfile.id, repliedProfile)
    }
  }
  /**
   * Convert `IndexedTransactionRANK` to `Profile`, using existing profile
   * from the queue or creating a new `Profile` object if it doesn't exist
   * @param rank `IndexedTransactionRANK` object
   * @returns `Profile` object
   */
  private toProfileFromRANK(rank: TransactionRANK): Profile {
    // Determine positive/negative stats per RANK sentiment
    let ranking = 0n
    let satsPositive = 0n
    let satsNegative = 0n
    let votesPositive = 0
    let votesNegative = 0
    // Do a switch here in case sentiment is more than binary in the future
    switch (rank.sentiment) {
      case 'positive':
        ranking += rank.sats
        satsPositive += rank.sats
        votesPositive++
        break
      case 'negative':
        ranking -= rank.sats
        satsNegative += rank.sats
        votesNegative++
        break
    }
    // pull out the fields we need to create a new profile/post
    const { platform, profileId, postId, ...partialRANK } = rank
    // check if this profile already exists in the queue
    let profile = this.profileQueue.get(profileId)
    // If this profile exists in the queue, add the RANK tx and update stats
    if (profile) {
      profile.ranking += ranking
      profile.satsPositive += satsPositive
      profile.satsNegative += satsNegative
      profile.votesPositive += votesPositive
      profile.votesNegative += votesNegative
      profile.ranks.push(partialRANK)
    }
    // Otherwise, we set up a new profile
    else {
      profile = {
        id: profileId,
        platform,
        ranks: [partialRANK],
        comments: undefined,
        ranking,
        satsPositive,
        satsNegative,
        votesPositive,
        votesNegative,
        posts: new Map(),
      }
    }
    // If we have a postId, update stats for this post if it exists, otherwise
    // add post to the map
    if (postId) {
      const post = profile.posts.get(postId)
      if (post) {
        post.ranking += ranking
        post.satsPositive += satsPositive
        post.satsNegative += satsNegative
        post.votesPositive += votesPositive
        post.votesNegative += votesNegative
        // Update lastVoted to the most recent timestamp
        post.lastVoted = partialRANK.timestamp ?? partialRANK.firstSeen / 1_000n
        post.ranks.push(partialRANK)
      } else {
        profile.posts.set(postId, {
          platform,
          id: postId,
          profileId,
          ranks: [partialRANK],
          comments: undefined,
          // use the block timestamp for firstVoted/lastVoted, otherwise use
          // the first-seen timestamp for mempool time (convert to seconds first)
          firstVoted: partialRANK.timestamp ?? partialRANK.firstSeen / 1_000n,
          lastVoted: partialRANK.timestamp ?? partialRANK.firstSeen / 1_000n,
          ranking,
          satsPositive,
          satsNegative,
          votesPositive,
          votesNegative,
        })
      }
    }
    // return the profile with posts
    return profile
  }
  /**
   * Convert `IndexedTransactionRNKC` to a Lotusia `Profile` object, using
   * existing profile from the queue or creating a new `Profile` object if it
   * doesn't exist
   * @param rnkc `IndexedTransactionRNKC` object
   * @returns Lotusia-specific `Profile` object
   */
  private toProfileFromRNKC(rnkc: TransactionRNKC): Profile {
    // pull out the fields we need to create a new profile/post
    const { scriptPayload: profileId, txid: postId, data } = rnkc
    // Check if the profile exists in the queue, otherwise create
    let profile = this.profileQueue.get(profileId)
    if (!profile) {
      profile = this.toProfile({
        id: profileId,
        // this is a Lotusia post, so we set the platform to lotusia
        platform: 'lotusia',
      })
    }
    // Increment profile ranking and satsPositive for the RNKC tx
    // This is effectively a self-vote on the profile
    profile.ranking += rnkc.sats
    profile.satsPositive += rnkc.sats
    profile.votesPositive++

    // Check if the post exists in the queued profile's posts, otherwise create
    let post = profile.posts.get(postId)
    if (!post) {
      post = this.toPost({
        id: postId,
        // this is a Lotusia post, so we set the platform to lotusia
        platform: 'lotusia',
        profileId,
        data,
        // use the block timestamp for firstVoted, otherwise use
        // the first-seen timestamp for mempool time (convert to seconds first)
        firstVoted: rnkc.timestamp ?? rnkc.firstSeen / 1_000n,
        lastVoted: rnkc.timestamp ?? rnkc.firstSeen / 1_000n,
      })
    } else if (!post.data && data) {
      // If the post was created by a RANK tx (without data), set the data
      // from the RNKC tx so the Post.data matches RankComment.data for the FK
      post.data = data
    }
    // Increment post ranking and satsPositive for the RNKC tx
    // This is effectively a self-vote on the post
    post.ranking += rnkc.sats
    post.satsPositive += rnkc.sats
    post.votesPositive++
    // Set the post in the profile's posts map
    profile.posts.set(postId, post)

    return profile
  }
  /**
   * Convert `IndexedTransactionRNKC` to `Profile`, using existing profile
   * from the queue as the replied profile, or creating a new `Profile` object
   * if it doesn't exist
   * @param rnkc `IndexedTransactionRNKC` object
   * @returns `Profile` object
   */
  private toRepliedProfileFromRNKC(rnkc: TransactionRNKC): Profile | null {
    // pull out the fields we need to create a new profile/post
    const {
      inReplyToPlatform,
      inReplyToProfileId,
      inReplyToPostId,
      ...partialRNKC
    } = rnkc
    // if there is no profileId, return undefined
    // This is a valid RNKC transaction, but it doesn't have a profileId so we
    // can't add it to the profile queue
    if (!inReplyToProfileId) {
      return null
    }
    // Check if the profile exists in the queue, otherwise create
    let profile = this.profileQueue.get(inReplyToProfileId)
    if (!profile) {
      profile = this.toProfile({
        id: inReplyToProfileId,
        platform: inReplyToPlatform,
      })
    }
    // If there is no postId, add the RNKC to the profile's comments and return
    if (!inReplyToPostId) {
      if (!profile.comments) {
        profile.comments = []
      }
      profile.comments.push(partialRNKC)
      return profile
    }
    // Add the RNKC to the post's comments
    let post = profile.posts.get(inReplyToPostId)
    if (post) {
      if (!post.comments) {
        post.comments = []
      }
      post.comments.push(partialRNKC)
    } else {
      post = this.toPost({
        id: inReplyToPostId,
        platform: inReplyToPlatform,
        profileId: inReplyToProfileId,
        comments: [partialRNKC],
        // use the block timestamp for firstVoted/lastVoted, otherwise use
        // the first-seen timestamp for mempool time (convert to seconds first)
        firstVoted: rnkc.timestamp ?? rnkc.firstSeen / 1_000n,
        lastVoted: rnkc.timestamp ?? rnkc.firstSeen / 1_000n,
      })
    }
    profile.posts.set(inReplyToPostId, post)
    return profile
  }
  /**
   * Build a skeleton `Post` object with the required fields, if provided
   * @param post `Partial<Post>` object to set the initial values for the post
   * @returns {Post}
   */
  private toPost(post?: Partial<Post>): Post {
    return {
      id: post?.id,
      platform: post?.platform,
      profileId: post?.profileId,
      ranks: post?.ranks,
      data: post?.data,
      comments: post?.comments || [],
      // Use the provided firstVoted/lastVoted timestamp, otherwise use
      // the current timestamp as a fallback
      firstVoted: post?.firstVoted ?? BigInt(Date.now()),
      lastVoted: post?.lastVoted ?? post?.firstVoted ?? BigInt(Date.now()),
      ranking: post?.ranking || 0n,
      satsPositive: post?.satsPositive || 0n,
      satsNegative: post?.satsNegative || 0n,
      votesPositive: post?.votesPositive || 0,
      votesNegative: post?.votesNegative || 0,
    }
  }
  /**
   * Build a skeleton `Profile` object with the required fields, if provided
   * @param profile `Partial<Profile>` object to set the initial values for the profile
   * @returns {Profile}
   */
  private toProfile(profile?: Partial<Profile>): Profile {
    return {
      id: profile?.id,
      platform: profile?.platform,
      ranks: profile?.ranks,
      comments: profile?.comments || [],
      ranking: profile?.ranking || 0n,
      satsPositive: profile?.satsPositive || 0n,
      satsNegative: profile?.satsNegative || 0n,
      votesPositive: profile?.votesPositive || 0,
      votesNegative: profile?.votesNegative || 0,
      posts: profile?.posts || new Map(),
    }
  }
  /**
   * Convert `MempoolCacheEntry` to a `PushNotification` object
   * @param tx `MempoolCacheEntry` object
   * @returns `PushNotification` object
   */
  // TODO: need to complete this function
  private toNotification(tx: MempoolCacheEntry): PushNotification {
    const notification = {
      title: 'New Activity',
    } as PushNotification
    let topic: Topic
    switch (tx.type) {
      // RANK transaction
      case 'RANK': {
        const rank = tx as TransactionRANK
        switch (rank.sentiment) {
          case 'positive':
            notification.title = 'You received an upvote'
            break
          case 'negative':
            notification.title = 'You received a downvote'
            break
          case 'neutral':
            notification.title = 'Someone viewed your post'
            break
        }
        notification.timestamp = Date.now()

        notification.body = rank.postId
          ? `on post ${rank.postId}`
          : `on your profile`
        break
      }
      // RNKC transaction
      case 'RNKC': {
        const rnkc = tx as TransactionRNKC
        notification.title = 'New RNKC transaction'
        notification.body = `New RNKC transaction: ${rnkc.txid}`
        break
      }
    }

    return notification
  }

  /**
   * Checks if a voter's scriptPayload has a FaucetClaim that needs advancing
   * to the next milestone. Called after each RANK tx is processed.
   *
   * Milestones are defined in FAUCET_MILESTONE_VOTES:
   *   - Milestone 1: 0 votes (on redemption — already handled by referralRedeem)
   *   - Milestone 2: 1 vote
   *   - Milestone 3: 5 votes
   *   - Milestone 4: 10 votes
   *
   * @param scriptPayload - The voter's scriptPayload
   */
  private async checkFaucetMilestone(scriptPayload: string): Promise<void> {
    // Look up the faucet claim for this wallet
    const claim = await this.db.getFaucetClaim(scriptPayload)
    if (!claim) return // No faucet claim — not a referred user

    // Check if all milestones are already completed
    const currentMilestone = claim.milestone
    if (currentMilestone > FAUCET_MILESTONE_VOTES.length) return

    // Get the vote threshold for the next milestone
    const nextMilestoneIndex = currentMilestone // 0-indexed into FAUCET_MILESTONE_VOTES
    if (nextMilestoneIndex >= FAUCET_MILESTONE_VOTES.length) return

    const requiredVotes = FAUCET_MILESTONE_VOTES[nextMilestoneIndex]
    const dripAmount = FAUCET_DRIP_AMOUNTS[nextMilestoneIndex]

    // Count the user's total RANK votes
    const totalVotes = await this.db.countRankTxsByScriptPayload(scriptPayload)

    // Check if the user has reached the next milestone
    if (totalVotes >= requiredVotes) {
      // Advance the milestone in the database
      await this.db.advanceFaucetMilestone(
        scriptPayload,
        currentMilestone + 1,
        dripAmount,
      )

      // Signal Temporal to process the faucet drip
      try {
        await this.temporal.client.workflow.signalWithStart(
          config.temporal.command.workflowType,
          {
            signal: config.temporal.command.signal,
            taskQueue: config.temporal.taskQueue,
            workflowId: config.temporal.command.workflowId,
            signalArgs: [
              {
                action: 'faucetDrip',
                data: {
                  scriptPayload,
                  milestone: currentMilestone + 1,
                  amount: dripAmount.toString(),
                },
              },
            ],
          },
        )
      } catch (e) {
        // Log but don't throw — the drip can be retried manually
        log([
          ['indexer', 'warn'],
          ['action', 'checkFaucetMilestone.temporal'],
          ['scriptPayload', scriptPayload],
          ['milestone', `${currentMilestone + 1}`],
          ['message', `"${String(e)}"`],
        ])
      }

      log([
        ['indexer', 'checkFaucetMilestone'],
        ['scriptPayload', scriptPayload],
        ['milestone', `${currentMilestone + 1}`],
        ['totalVotes', `${totalVotes}`],
        ['dripAmount', dripAmount.toString()],
      ])
    }
  }
}
