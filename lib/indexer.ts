import { Chunk, Transaction } from 'bitcore-lib-xpi'
import { Builder, ByteBuffer } from 'flatbuffers'
import { isIP } from 'validator'
import * as NNG from './nng-interface'
import { Socket, socket } from 'nanomsg'
import { resolve } from 'node:path/posix'
import { Worker } from 'node:worker_threads'
import { EventEmitter } from 'events'
import Database from './database'
import {
  toCommentUTF8,
  toProfileIdUTF8,
  toPlatformUTF8,
  toSentimentUTF8,
  log,
  RANK_SCRIPT_REQUIRED_LENGTH,
} from 'rank-lib'
import {
  ERR,
  NNG_PUB_DEFAULT_SOCKET_PATH,
  NNG_RPC_DEFAULT_SOCKET_PATH,
  NNG_REQUEST_TIMEOUT_LENGTH,
  NNG_RPC_BLOCKRANGE_SIZE,
  NNG_RPC_RCVMAXSIZE_POLICY,
  NNG_SOCKET_MAXRECONN,
  NNG_SOCKET_RECONN,
  NNG_MESSAGE_BATCH_SIZE,
} from '../util/constants'
import {
  PLATFORMS,
  RANK_BLOCK_GENESIS_V1,
  RANK_OUTPUT_MIN_VALID_SATS,
  RANK_SCRIPT_CHUNKS_REQUIRED,
  RANK_SCRIPT_CHUNKS_OPTIONAL,
} from 'rank-lib'
import type {
  LogEntry,
  RankOutput,
  RankTransaction,
  Block,
  ProfileMap,
  RankTarget,
  ScriptChunk,
  ScriptChunkField,
  ScriptChunkPlatformUTF8,
  ScriptChunkSentimentUTF8,
} from 'rank-lib'
/** NNG types */
type NNGMessageType =
  | 'mempooltxadd'
  | 'mempooltxrem'
  | 'blkconnected'
  | 'blkdisconctd'
type NNGMessageProcessor = (bb: ByteBuffer) => Promise<void>
type NNGPendingMessageProcessor = [NNGMessageProcessor, ByteBuffer]
type NNGQueue = {
  busy: boolean
  pending: NNGPendingMessageProcessor[]
}
/** Runtime cache for quickly reconciling conflicting RANK txs with blocks */
type MempoolCache = Map<string, RankTransaction>
/**
 * Processes all transactions to find, parse, and index OP_RETURN outputs with
 * the `RANK` LOKAD prefix.
 *
 * Maintains a persistent connection to lotusd over the NNG interface. Subscribes
 * to the appropriate lotusd publishing endpoints and reacts to new messages
 * accordingly.
 */
export default class Indexer extends EventEmitter {
  /** Database instance for storing indexed data */
  private db: Database
  /** NNG pub/sub socket for receiving messages from lotusd */
  private pub: Socket
  /** NNG request/reply socket for RPC calls to lotusd */
  private rpc: Socket
  /** URI for the pub/sub socket connection */
  private pubUri: string
  /** URI for the RPC socket connection */
  private rpcUri: string
  /** Cache of unconfirmed RANK transactions */
  private mempool: MempoolCache
  /** Queue for processing NNG messages */
  private queue: NNGQueue
  /** Required script chunk definitions */
  private chunksRequired = Object.entries(RANK_SCRIPT_CHUNKS_REQUIRED) as [
    keyof typeof RANK_SCRIPT_CHUNKS_REQUIRED,
    ScriptChunk,
  ][]
  /** Optional script chunk definitions */
  private chunksOptional = Object.entries(RANK_SCRIPT_CHUNKS_OPTIONAL) as [
    keyof typeof RANK_SCRIPT_CHUNKS_OPTIONAL,
    ScriptChunk,
  ][]
  /** Last processed block checkpoint */
  private checkpoint: Block
  /**
   * Creates a new Indexer instance that connects to lotusd via NNG sockets
   * @param db Database instance for storing indexed data
   * @param pubUri Optional path to the NNG pub/sub socket (defaults to ~/.lotus/pub.pipe)
   * @param rpcUri Optional path to the NNG RPC socket (defaults to ~/.lotus/rpc.pipe)
   */
  constructor(db: Database, pubUri?: string, rpcUri?: string) {
    super()
    // Validate NNG parameters
    this.pubUri = `ipc://${pubUri}`
    this.rpcUri = `ipc://${rpcUri}`
    // Module setup
    this.db = db
    // Pub/Sub socket setup
    this.pub = socket('sub', { chan: [] })
    this.pub.on('data', this.nngReceiveMessage)
    this.pub.rcvmaxsize(NNG_RPC_RCVMAXSIZE_POLICY)
    this.pub.reconn(NNG_SOCKET_RECONN)
    this.pub.maxreconn(NNG_SOCKET_MAXRECONN)
    // RPC socket setup
    this.rpc = socket('req')
    this.rpc.rcvmaxsize(NNG_RPC_RCVMAXSIZE_POLICY * NNG_RPC_BLOCKRANGE_SIZE)
    this.rpc.reconn(NNG_SOCKET_RECONN)
    this.rpc.maxreconn(NNG_SOCKET_MAXRECONN)
    // Runtime state setup
    this.mempool = new Map()
    this.queue = { busy: false, pending: [] }
  }
  /**
   * Converts a Block or RankTransaction object into an array of LogEntry tuples
   * @param data - The Block or RankTransaction object to convert
   * @returns Array of [key, value] tuples representing the object's properties as strings
   */
  private toLogEntries(data: Block | RankTransaction): LogEntry[] {
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
    try {
      this.rpc.connect(this.rpcUri)
      this.pub.connect(this.pubUri)
      if (!this.rpc.connected || !this.pub.connected) {
        throw new Error(
          `NNG failed to connect. Make sure NNG is enabled in your lotus.conf and try again.`,
        )
      }
    } catch (e) {
      throw [ERR.NNG_CONNECT, e.message]
    }
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
      const mempooltxs = await this.db.getRankTransactionsByHeight(null)
      if (mempooltxs.length > 0) {
        const profiles = this.toProfileMap(mempooltxs)
        await this.db.rewindProfiles(profiles)
        const t1 = (performance.now() - t0).toFixed(3)
        log([
          ['init', 'cleanup'],
          ['ranksLength', `${mempooltxs.length}`],
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
    try {
      // Get current checkpoint from DB
      const dbCheckpoint = await this.db.getCheckpoint()
      // Initialize from either DB checkpoint or genesis block
      const initialCheckpoint = dbCheckpoint ?? (RANK_BLOCK_GENESIS_V1 as Block)
      // Reconcile with blockchain state
      this.checkpoint = await this.initReconcileBlockState(initialCheckpoint)
    } catch (e) {
      throw [ERR.IDX_BLOCKS_REWIND, e.message]
    }
    // Log our current checkpoint (i.e. best block)
    log([['init', 'best'], ...this.toLogEntries(this.checkpoint)])
    // Sync blocks
    try {
      await this.initSyncBlocks()
    } catch (e) {
      throw [ERR.IDX_BLOCKS_SYNC, e.message]
    }
    // Sync mempool
    try {
      const ranks = await this.initSyncMempool()
      // Initialize the mempool queue with these RANK txs
      ranks.forEach(rank => this.mempool.set(rank.txid, rank))
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
    this.pub.chan(channels)
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
  async initSyncBlocks(): Promise<void> {
    let totalBlocks = 0,
      totalRanks = 0
    const t0 = performance.now()
    while (true) {
      const startHeight = this.checkpoint.height + 1
      const t0 = performance.now()
      const blockrange = await this.rpcGetBlockRange(
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
      ;[this.checkpoint, ranksLength] = await this.saveBlockRange(
        blockrange,
        blocksLength,
      )
      totalBlocks += blocksLength
      totalRanks += ranksLength
      const t1 = (performance.now() - t0).toFixed(3)
      log([
        ['init', 'syncBlocks'],
        ['status', 'running'],
        ['startHeight', `${startHeight}`],
        ['endHeight', `${this.checkpoint.height}`],
        [`ranksLength`, `${ranksLength}`],
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
      ['elapsed', `${t1}s`],
    ])
  }
  /**
   * Synchronizes database state with the current lotusd mempool by fetching and processing unconfirmed transactions
   * @returns {Promise<RankTransaction[]>} Array of RANK transactions currently in mempool
   * @property {number} txsLength - Number of transactions in mempool
   * @property {number} ranksLength - Number of RANK transactions processed
   * @property {number} elapsed - Time taken to sync mempool in milliseconds
   */
  async initSyncMempool(): Promise<RankTransaction[]> {
    const t0 = performance.now()
    const entries: LogEntry[] = [['init', 'syncMempool']]
    const mempool = await this.rpcGetMempool()
    const txsLength = mempool.txsLength()
    entries.push(['txsLength', `${txsLength}`])
    let ranks: RankTransaction[] = []
    if (txsLength > 0) {
      ranks = this.processBlockOrMempool(mempool)
      if (ranks.length > 0) {
        const profiles = this.toProfileMap(ranks)
        await this.db.upsertProfiles(profiles)
        const t1 = (performance.now() - t0).toFixed(3)
        entries.push(
          ['ranksLength', `${ranks.length}`],
          ['action', 'upsertProfiles'],
          ['elapsed', `${t1}ms`],
        )
      }
    }
    log(entries)
    // Return the RANK txs currently in mempool
    return ranks
  }
  /**
   * Cleanly shuts down all network connections and closes the indexer
   * @returns {Promise<void>} Resolves when all connections are closed
   */
  async close(): Promise<void> {
    this.pub?.shutdown(this.pubUri)
    this.pub?.close()
    this.rpc?.shutdown(this.rpcUri)
    this.rpc?.close()
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
      const best = await this.rpcGetBlock(checkpoint.height)
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
   * Process the range of `NNG.Block` objects for RANK tranactions and save all `Block`s as checkpoints
   * @param blockrange `NNG.GetBlockRangeResponse` object providing array of `NNG.Block`
   * @param blocksLength Length of `NNG.Block` array
   * @returns {Promise<[ Block, number ]>}
   * Tuple containing latest `Block` as new checkpoint and `number` of RANK txs in the `blockrange`
   */
  private async saveBlockRange(
    blockrange: NNG.GetBlockRangeResponse,
    blocksLength: number,
  ): Promise<[Block, number]> {
    const blocks: Block[] = []
    const ranks: RankTransaction[] = []
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
        const result = this.processBlockOrMempool(block)
        // Saving these for later
        blocks.push({ ...checkpoint, ranksLength: result.length })
        ranks.push(...result)
      } catch (e) {
        throw new Error(
          `saveBlockRange(${typeof blockrange}, ${blocksLength}): ${e.message}`,
        )
      }
    }
    // Save blocks and Profile upserts in one atomic database transaction
    const profiles = this.toProfileMap(ranks)
    try {
      await this.db.saveBlockRange(blocks, profiles)
    } catch (e) {
      throw new Error(
        `db.saveBlockRange(${typeof blocks}, ${typeof profiles}): ${e.message}`,
      )
    }
    // Return the latest block as the new checkpoint block
    return [blocks.pop(), ranks.length]
  }
  /**
   * Rewind the database state created at `height`
   * @param height `height` parsed from `NNG.BlockHeader`
   * @returns Number of `RankTransaction`s removed from database
   */
  private async rewindBlock(height: number): Promise<number> {
    try {
      const ranks = await this.db.getRankTransactionsByHeight(height)
      const profiles = this.toProfileMap(ranks)
      await this.db.rewindProfiles(profiles)
      await this.db.deleteBlockByHeight(height)
      return ranks.length
    } catch (e) {
      throw new Error(`rewindBlock(${height}: ${e.message}`)
    }
  }
  /**
   * Process queued NNG message handlers in batches with a small delay between batches.
   * Processes up to NNG_MESSAGE_BATCH_SIZE messages at a time to avoid blocking the event loop.
   * @returns {Promise<void>} Resolves when current batch is complete
   */
  private nngProcessMessage = async (): Promise<void> => {
    // Queue is now busy processing queued NNG handlers
    // Prevents clobbering; maintains healthy database state
    this.queue.busy = true
    try {
      // Process messages in batches with a small delay
      const messagesToProcess = this.queue.pending.splice(
        0,
        NNG_MESSAGE_BATCH_SIZE,
      )

      for (const [NNGMessageProcessor, ByteBuffer] of messagesToProcess) {
        await NNGMessageProcessor(ByteBuffer)
      }
    } catch (e) {
      this.emit('exception', ERR.NNG_PROCESS_MESSAGE, e.message)
      this.queue.busy = false
      return
    }

    // Schedule next batch with a small delay to allow event loop to breathe
    if (this.queue.pending.length > 0) {
      setTimeout(() => this.nngProcessMessage(), 10)
    } else {
      this.queue.busy = false
    }
  }
  /**
   * Called when our NNG sub `Socket` receives data published by lotusd
   * @param msg Raw `Buffer` containing `NNGMessageType` prefix and `ByteBuffer` data
   * @returns {Promise<void>}
   */
  private nngReceiveMessage = async (msg: Buffer): Promise<void> => {
    // Parse out the message type and convert message to ByteBuffer
    const msgType = msg.subarray(0, 12).toString() as NNGMessageType
    const bb = new ByteBuffer(msg.subarray(12))
    // Add the appropriate message handler to the back of the processing queue
    switch (msgType) {
      case 'mempooltxadd':
        this.queue.pending.push([this.nngMempoolTxAdd, bb])
        break
      case 'mempooltxrem': // tx removed from mempool due to conflict, reorg, etc.
        this.queue.pending.push([this.nngMempoolTxRemove, bb])
        break
      case 'blkconnected':
        this.queue.pending.push([this.nngBlockConnected, bb])
        break
      case 'blkdisconctd':
        this.queue.pending.push([this.nngBlockDisconnected, bb])
        break
    }
    // Set immediate processing of the message queue if not already busy
    if (!this.queue.busy) {
      setImmediate(this.nngProcessMessage)
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
      NNG.TransactionAddedToMempool.getRootAsTransactionAddedToMempool(
        bb,
      ).mempoolTx()
    const rawArray = mempooltx.tx().rawArray()
    const tx = new Transaction(Buffer.from(rawArray))
    // silently ignore RANK txs that send change to a different address
    const scriptPayload = this.getScriptPayload(tx)
    if (!scriptPayload) {
      return
    }
    const output = this.toRankOutput(tx.outputs[0])
    if (output) {
      const rank = {
        txid: tx.txid,
        scriptPayload,
        timestamp: mempooltx.time(),
        sats: BigInt(tx.outputs[0].satoshis),
        ...output,
      } as RankTransaction
      const profiles = this.toProfileMap([rank])
      await this.db.upsertProfiles(profiles)
      const t1 = (performance.now() - t0).toFixed(3)
      // Keep this RANK tx to reconcile with next block
      this.mempool.set(tx.txid, rank)
      log([
        ['nng', 'mempooltxadd'],
        ...this.toLogEntries(rank),
        ['action', 'upsertProfiles'],
        ['elapsed', `${t1}ms`],
      ])
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
      NNG.TransactionRemovedFromMempool.getRootAsTransactionRemovedFromMempool(
        bb,
      )
    const txid = this.toBlockhashOrTxid(tx.txid().hash())
    // Get the RANK tx from in-memory mempool cache
    const rank = this.mempool.get(txid)
    // Make sure our in-memory cache had the conflicting tx
    if (rank) {
      // Rewind the associated profile
      const profiles = this.toProfileMap([rank])
      await this.db.rewindProfiles(profiles)
      const t1 = (performance.now() - t0).toFixed(3)
      // Remove the RANK tx from mempool cache
      this.mempool.delete(txid)
      // Log the result
      log([
        ['nng', 'mempooltxrem'],
        ...this.toLogEntries(rank),
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
    const connectedBlock = NNG.BlockConnected.getRootAsBlockConnected(bb)
    // Get the NNG block and convert header to database `Block` entry
    const block = connectedBlock.block()
    const best = this.toBlock(block.header())
    // Process block for any RANK txs
    const ranks = this.processBlockOrMempool(block)
    best.ranksLength = ranks.length
    entries.push(...this.toLogEntries(best))
    // Prepare ProfileMap in case any RANK txs need to be upserted
    let profiles: ProfileMap = new Map()
    const rankTxids: Pick<RankTransaction, 'txid'>[] = []
    if (ranks.length > 0) {
      // Find any RANK txs that were missing from mempool cache (i.e. not already upserted)
      const missing = ranks.filter(rank => {
        // If mempool has RANK tx from block then it can be removed
        if (this.mempool.has(rank.txid)) {
          // save this txid for database connect statement
          rankTxids.push({ txid: rank.txid })
          // Mempool no longer contains this RANK tx
          this.mempool.delete(rank.txid)
          return false
        }
        // If we can't find the block RANK tx in mempool cache, return it as missing
        return true
      })
      // Convert missing RANK txs to profiles for upsert
      if (missing.length > 0) {
        profiles = this.toProfileMap(missing)
      }
    }
    // Save latest checkpoint plus any missing RANK txs
    await this.db.saveBlock(best, rankTxids, profiles)
    const t1 = (performance.now() - t0).toFixed(3)
    entries.push(['action', 'saveBlock'], ['elapsed', `${t1}ms`])
    // TODO: we may need to add some additional state checks here, but maybe not

    // Update checkpoint to this block
    this.checkpoint = { ...best }
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
      NNG.BlockDisconnected.getRootAsBlockDisconnected(bb).block()
    const block = this.toBlock(disconnectedBlock.header())
    // Rewind the disconnected block
    const txsLength = await this.rewindBlock(block.height)
    const t1 = (performance.now() - t0).toFixed(3)
    // Get the latest checkpoint block from the database
    this.checkpoint = await this.db.getCheckpoint()
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
   * Send RPC command to lotusd over NNG interface (`this.rpc`)
   * @param rpcType Valid RPC request string, e.g. `GetMempoolRequest`
   * @param params Object containing data required to build `NNG.RpcRequest` for provided `rpcType`, if applicable
   * @returns {Promise<ByteBuffer>} `NNG.RpcResult` converted to `ByteBuffer`
   */
  private async rpcCall(
    rpcType: keyof typeof NNG.RpcRequest,
    params?: {
      blockRangeRequest?: { startHeight: number; numBlocks: number }
      blockRequest?: { height: number }
    },
  ): Promise<ByteBuffer> {
    // Set up builder and get proper flatbuffer offset for rpcType
    const builder = new Builder()
    let offset: number
    switch (rpcType) {
      case 'GetMempoolRequest':
        offset = NNG.GetMempoolRequest.createGetMempoolRequest(builder)
        break
      case 'GetBlockRangeRequest':
        offset = NNG.GetBlockRangeRequest.createGetBlockRangeRequest(
          builder,
          params.blockRangeRequest.startHeight,
          params.blockRangeRequest.numBlocks,
        )
        break
      case 'GetBlockRequest':
        offset = NNG.GetBlockRequest.createGetBlockRequest(
          builder,
          NNG.BlockIdentifier.Height,
          NNG.BlockHeight.createBlockHeight(
            builder,
            params.blockRequest.height,
          ),
        )
        break
    }
    const rpcCall = NNG.RpcCall.createRpcCall(
      builder,
      NNG.RpcRequest[rpcType],
      offset,
    )
    builder.finish(rpcCall)
    // Wrap the event listener and `rpc.send()` in a Promise to await response
    // Promise is resolved via `.once()` event after lotusd responds
    // Then we can process the response data accordingly
    const bb = <ByteBuffer>await new Promise((resolve, reject) => {
      const rpcSocketSendTimeout = setTimeout(
        () =>
          reject(
            `rpcCall(${rpcType}, ${typeof params}): Socket timeout (${NNG_REQUEST_TIMEOUT_LENGTH}ms)`,
          ),
        NNG_REQUEST_TIMEOUT_LENGTH,
      )
      // set up response listener before sending request; avoids race condition
      this.rpc.once('data', (buf: Buffer) => {
        clearTimeout(rpcSocketSendTimeout)
        resolve(new ByteBuffer(buf))
      })
      this.rpc.send(builder.asUint8Array() as Buffer)
    })
    const result = NNG.RpcResult.getRootAsRpcResult(bb)
    if (!result.isSuccess()) {
      // If the RPC call was successful but returned error data, process that now
      switch (result.errorCode()) {
        case 5: // block not found
          return null
        // what's happening
        default:
          throw new Error(
            `rpcCall(${rpcType}, ${typeof params}): ${result.errorMsg()} (code: ${result.errorCode()})`,
          )
      }
    }
    return new ByteBuffer(result.dataArray())
  }
  /**
   * Fetch block at `height`
   * @param height `height` parsed from `NNG.BlockHeader`
   * @returns {Promise<NNG.Block>}
   */
  private async rpcGetBlock(height: number): Promise<NNG.Block> {
    try {
      const bb = await this.rpcCall('GetBlockRequest', {
        blockRequest: { height },
      })
      return bb?.bytes()?.length
        ? NNG.GetBlockResponse.getRootAsGetBlockResponse(bb).block()
        : null
    } catch (e) {
      throw new Error(`rpcGetBlock(${height}): ${e.message}`)
    }
  }
  /**
   * Fetches mempool txs
   * @returns {Promise<NNG.GetMempoolResponse>}
   */
  private async rpcGetMempool(): Promise<NNG.GetMempoolResponse> {
    try {
      const bb = await this.rpcCall('GetMempoolRequest')
      return NNG.GetMempoolResponse.getRootAsGetMempoolResponse(bb)
    } catch (e) {
      throw new Error(`rpcGetMempool(): ${e.message}`)
    }
  }
  /**
   * Fetches range of blocks from `startHeight`, up to `numBlocks` limit
   * @param startHeight The starting `height` parsed from `NNG.BlockHeader`
   * @param numBlocks Configure `NNG_RPC_BLOCKRANGE_SIZE` in `/util/constants.ts` (default: 20)
   * @returns {Promise<NNG.GetBlockRangeResponse>}
   */
  private async rpcGetBlockRange(
    startHeight: number,
    numBlocks: number,
  ): Promise<NNG.GetBlockRangeResponse> {
    try {
      const bb = await this.rpcCall('GetBlockRangeRequest', {
        blockRangeRequest: { startHeight, numBlocks },
      })
      return NNG.GetBlockRangeResponse.getRootAsGetBlockRangeResponse(bb)
    } catch (e) {
      throw new Error(
        `rpcGetBlockRange(${startHeight}, ${numBlocks}): ${e.message}`,
      )
    }
  }
  /**
   *
   * @param data
   * @returns
   */
  private processBlockOrMempool(
    data: NNG.Block | NNG.GetMempoolResponse,
  ): RankTransaction[] {
    const ranks: RankTransaction[] = []
    const txsLength = data.txsLength()
    const block = data instanceof NNG.Block ? this.toBlock(data.header()) : null
    // skip coinbase tx if processing block data
    for (let i = block ? 1 : 0; i < txsLength; i++) {
      try {
        const rawArray = data.txs(i).tx().rawArray()
        // Convert Uint8Array to Buffer else bitcore parse will fail
        const tx = new Transaction(Buffer.from(rawArray))
        // get the address that spent UTXO
        // TODO: should collect multiple scriptPayloads into array;
        //       this would allow multiple addresses to vote at once 👀
        //       WARNING: this could open attack surface to game reward system,
        //                e.g. 2 addresses, 1 vote = 1 vote, 2 addresses rewarded
        // silently ignore RANK txs that send change to a different address
        const scriptPayload = this.getScriptPayload(tx)
        if (!scriptPayload) {
          continue
        }
        // RANK output is always at index 0
        const output = this.toRankOutput(tx.outputs[0])
        if (output) {
          ranks.push({
            txid: tx.txid,
            scriptPayload,
            height: block?.height, // undefined if mempool tx
            sats: BigInt(tx.outputs[0].satoshis),
            timestamp:
              block?.timestamp ?? BigInt(Math.round(Date.now() / 1000)),
            ...output,
          })
        }
      } catch (e) {
        throw new Error(`processBlockOrMempool(${typeof data}): ${e.message}`)
      }
    }
    return ranks
  }
  /**
   * Process the output script to get the rankOutput
   * @param output `Transaction.Output` object
   * @returns `RankOutput` object or `null` if output script is invalid
   */
  private toRankOutput(output: Transaction.Output): RankOutput {
    const { script, satoshis } = output
    // first output script MUST be OP_RETURN
    if (!script.isDataOut()) {
      return null
    }
    // OP_RETURN output value MUST be >= defined minimum
    if (satoshis < RANK_OUTPUT_MIN_VALID_SATS) {
      return null
    }
    // Buffer of output script
    const scriptBuf = script.toBuffer()
    // platform name
    const rankOutput: RankOutput = {
      sentiment: null,
      platform: null,
      profileId: null,
    }
    // parse required chunks into rankOutput
    // return null if any required chunk is missing
    for (const [requiredChunkField, requiredChunk] of this.chunksRequired) {
      const scriptChunkBuf = scriptBuf.subarray(
        requiredChunk.offset,
        requiredChunk.offset + requiredChunk.len,
      )
      const scriptChunkHex = scriptChunkBuf.toString('hex')
      const scriptChunkUIntBE = parseInt(scriptChunkHex, 16)
      switch (requiredChunkField) {
        // default processing for chunks that have a map
        default: {
          if (requiredChunk.map) {
            if (!requiredChunk.map.has(scriptChunkUIntBE)) {
              return null
            }
          }
          // do not break here; fallthrough to chunk-specific processing
        }
        case 'sentiment': {
          rankOutput.sentiment = toSentimentUTF8(scriptChunkBuf)
          break
        }
        case 'platform': {
          rankOutput.platform = toPlatformUTF8(scriptChunkBuf)
          break
        }
        case 'profileId': {
          const profileIdSpec = PLATFORMS[rankOutput.platform].profileId
          const profileIdBuf = scriptBuf.subarray(
            requiredChunk.offset,
            requiredChunk.offset + profileIdSpec.len,
          )
          // profileId chunk must be padded to required length
          if (profileIdBuf.length < profileIdSpec.len) {
            return null
          }
          // convert profileId to UTF-8 and remove padding null bytes
          rankOutput.profileId = toProfileIdUTF8(profileIdBuf)
          break
        }
      }
    }
    const scriptBufOptional = scriptBuf.subarray(RANK_SCRIPT_REQUIRED_LENGTH)
    // if there are any remaining chunks, process them into rankOutput
    if (scriptBufOptional.length > 0) {
      for (const [optionalChunkField] of this.chunksOptional) {
        switch (optionalChunkField) {
          case 'postId': {
            const postIdSpec =
              PLATFORMS[rankOutput.platform as ScriptChunkPlatformUTF8].postId
            try {
              rankOutput.postId =
                scriptBufOptional[postIdSpec.reader]().toString()
            } catch (e) {
              // leave postId undefined if reader fails
              // TODO: need to add fallbacks for platforms with variable postId format
            }
            break
          }
          // TODO: add cases for additional optional chunks
        }
      }
    }
    // return the processed rankOutput
    return rankOutput
  }
  /**
   * Process `Transaction.Input` objects to get the `scriptPayload`
   * Only return the `scriptPayload` if all inputs are from the same address
   * @param tx `Transaction` object
   * @returns `scriptPayload` as a hex string or `void` if inputs are invalid
   */
  private getScriptPayload(tx: Transaction): string | void {
    if (
      tx.inputs.every(
        (input, _idx, array) =>
          array[0].script
            .toAddress()
            .hashBuffer.compare(input.script.toAddress().hashBuffer) === 0,
      )
    ) {
      return tx.inputs[0].script.toAddress().hashBuffer.toString('hex')
    }
  }
  /**
   * Parse raw `NNG.Hash` flatbuffer for the 32-byte block hash or txid
   * @param hash Raw `NNG.Hash`
   * @returns {string} Block hash or txid as hex string (little endian)
   */
  private toBlockhashOrTxid(hash: NNG.Hash): string {
    return Buffer.from(hash.bb.bytes().slice(hash.bb_pos, hash.bb_pos + 32))
      .reverse() // reverse for little endian
      .toString('hex')
  }
  /**
   * Parse raw `NNG.BlockHeader` flatbuffer for the nHeight
   * (https://docs.givelotus.org/specs/blockheader)
   * @param header Raw `NNG.BlockHeader`
   * @returns {number} Block height as a number
   */
  private toBlockHeight(header: NNG.BlockHeader): number {
    // header could be undefined if processing mempool tx from nng
    if (!header) {
      return undefined
    }
    const nHeight = header.rawArray().subarray(60, 64)
    return Buffer.from(nHeight).readUInt32LE()
  }
  /**
   *
   * @param header
   * @param includePrevHash
   * @returns
   */
  private toBlock(header: NNG.BlockHeader, includePrevhash = false): Block {
    try {
      const height = this.toBlockHeight(header)
      const timestamp = header.timestamp()
      const hash = this.toBlockhashOrTxid(header.blockHash().hash())
      const block: Block = { hash, height, timestamp, ranksLength: 0 }
      if (includePrevhash) {
        block.prevhash = this.toBlockhashOrTxid(header.prevBlockHash().hash())
      }
      return block
    } catch (e) {
      throw new Error(`toBlock(${header}, ${includePrevhash}): ${e.message}`)
    }
  }
  /**
   * Convert `RankTransaction` Array into Map of `Profile`s
   * @param ranks Array of `RankTransaction` objects
   * @returns {ProfileMap} Map where key is `profileId` and value is `Profile` object
   */
  private toProfileMap(ranks: RankTransaction[]): ProfileMap {
    const profiles: ProfileMap = new Map()
    // Sort the RANK txs for upsert
    ranks.forEach(rank => {
      // Determine positive/negative stats per RANK sentiment
      let ranking = 0n
      let votesPositive = 0
      let votesNegative = 0
      // Do a switch here in case sentiment is more than binary in the future
      switch (rank.sentiment as ScriptChunkSentimentUTF8) {
        case 'positive':
          ranking += rank.sats
          votesPositive++
          break
        case 'negative':
          ranking += -rank.sats
          votesNegative += 1
          break
      }
      const { platform, profileId, postId, ...partialRank } = rank
      const target: RankTarget = {
        id: null,
        platform,
        ranks: [],
        ranking,
        votesPositive,
        votesNegative,
      }
      let profile = profiles.get(profileId)
      if (profile) {
        profile.ranking += ranking
        profile.votesPositive += votesPositive
        profile.votesNegative += votesNegative
        profile.ranks.push(partialRank)
      } else {
        profiles.set(profileId, {
          ...target,
          id: profileId,
          ranks: [partialRank],
          posts: new Map(),
        })
        profile = profiles.get(profileId)
      }
      // If we don't have a postId, then this RANK tx belongs to the Profile
      // Add the RANK tx and return to process next RANK tx
      if (!postId) {
        return
      }
      // Otherwise, we set up the Post and attach this RANK tx to it
      const post = profile.posts.get(postId)
      if (post) {
        post.ranking += ranking
        post.votesPositive += votesPositive
        post.votesNegative += votesNegative
        post.ranks.push(partialRank)
        return
      }
      profile.posts.set(postId, {
        ...target,
        id: postId,
        profileId,
        ranks: [partialRank],
      })
    })
    return profiles
  }
}
