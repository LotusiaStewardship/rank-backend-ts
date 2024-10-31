import { Script, Transaction } from '@abcpros/bitcore-lib-xpi'
import { Builder, ByteBuffer } from 'flatbuffers'
import { isIP } from 'validator'
import * as NNG from './nng-interface'
import { Socket, socket } from 'nanomsg'
import Database from './database'
import {
  RANK_SCRIPT_PARTS,
  RANK_SCRIPT_MIN_BYTE_LENGTH,
  NNG_REQUEST_TIMEOUT_LENGTH,
  NNG_RPC_BLOCKRANGE_SIZE,
  NNG_RPC_RCVMAXSIZE_CONSENSUS,
  NNG_SOCKET_MAXRECONN,
  NNG_SOCKET_RECONN,
  ERR,
  NNG_PUB_DEFAULT_SOCKET_PATH,
  NNG_RPC_DEFAULT_SOCKET_PATH
} from '../util/constants'
import { IndexerLogEntry, log } from '../util'
import { resolve } from 'node:path/posix'
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
/** RANK script types */
type ScriptPartChunk = keyof typeof RANK_SCRIPT_PARTS
type ScriptPart = {
  offset: number
  len: number
  values?: string[]
}
/** OP_RETURN <RANK> <sentiment> <profileId> [<postId> <commentHex>] */
type RankOutput = {
  platform: string // e.g. Twitter/X.com, etc.
  profileId: string // who the ranking is for
  sentiment: string // true = positive, false = negative
  sats: bigint // sats for sentiment
}
/**  */
export type RankTransaction = RankOutput & {
  txid: string
  height?: number // undefined if mempool
  timestamp: bigint // unix timestamp
}
/**  */
export type Profile = {
  id: string
  platform: string
  ranking: bigint
  ranks: Omit<RankTransaction, 'profileId' | 'platform'>[] // omit the database relation fields
  votesPositive: number
  votesNegative: number
}
/**
 * `RankTransaction` objects are converted to a `ProfileMap` for database ops
 *
 * `string` is `profileId`
 */
export type ProfileMap = Map<string, Profile>
/** */
export type Block = {
  hash: string
  height: number
  timestamp: bigint
  ranksLength: number // default is 0 if a block is cringe
  prevhash?: string // for reorg checks only; does not get saved to database
}
/**  */
type MempoolCache = Map<string, RankTransaction>
/** First block with a RANK transaction */
const GENESIS_BLOCK_V1: Partial<Block> = {
  hash: '00000000019cc1ddc04bc541f531f1424d04d0c37443867f1f6137cc7f7d09e5',
  height: 811624,
}
/** Signal to would-be promises that they should think twice before resolving */
export class Indexer {
  private db: Database
  private pub: Socket
  private rpc: Socket
  private pubUri: string
  private rpcUri: string
  private mempool: MempoolCache
  private queue: NNGQueue
  // 😏
  private parts: {
    required: {
      [chunk in Exclude<ScriptPartChunk, 'POST' | 'COMMENT'>]: ScriptPart
    }
    optional: {
      [chunk in Extract<ScriptPartChunk, 'POST' | 'COMMENT'>]: ScriptPart
    }
  }
  private checkpoint: Block
  /**
   *
   * @param pubUri
   * @param rpcUri
   */
  constructor(protocol?: 'ipc' | 'tcp', pubUri?: string, rpcUri?: string) {
    // Validate NNG parameters
    switch (protocol) {
      case 'ipc':
        this.pubUri = `ipc://${resolve(pubUri)}`
        this.rpcUri = `ipc://${resolve(rpcUri)}`
        break
      case 'tcp':
        let invalidIP: string = null
        if (!isIP(pubUri)) {
          invalidIP = pubUri
        }
        if (!isIP(rpcUri)) {
          invalidIP = rpcUri
        }
        if (invalidIP) {
          throw new Error(`protocol tcp expects valid IP address, got "${invalidIP}"`)
        }
        this.pubUri = `tcp://${pubUri}`
        this.rpcUri = `tcp://${rpcUri}`
        break
      default:
        this.pubUri = `ipc://${resolve(NNG_PUB_DEFAULT_SOCKET_PATH)}`
        this.rpcUri = `ipc://${resolve(NNG_RPC_DEFAULT_SOCKET_PATH)}`
    }
    // Module setup
    this.db = new Database()
    // Pub/Sub socket setup
    this.pub = socket('sub', { chan: [] })
    this.pub.on('error', this.close)
    this.pub.on('data', this.nngReceiveMessage)
    this.pub.rcvmaxsize(NNG_RPC_RCVMAXSIZE_CONSENSUS)
    this.pub.reconn(NNG_SOCKET_RECONN)
    this.pub.maxreconn(NNG_SOCKET_MAXRECONN)
    // RPC socket setup
    this.rpc = socket('req')
    this.rpc.on('error', this.close)
    this.rpc.rcvmaxsize(NNG_RPC_RCVMAXSIZE_CONSENSUS * NNG_RPC_BLOCKRANGE_SIZE)
    this.rpc.reconn(NNG_SOCKET_RECONN)
    this.rpc.maxreconn(NNG_SOCKET_MAXRECONN)
    // Runtime state setup
    this.mempool = new Map()
    this.queue = { busy: false, pending: [] }
    this.parts = {
      required: {
        LOKAD: {
          offset: 2,
          len: 4,
          values: Object.values(RANK_SCRIPT_PARTS.LOKAD),
        },
        SENTIMENT: {
          offset: 6,
          len: 1,
          values: Object.values(RANK_SCRIPT_PARTS.SENTIMENT),
        },
        PLATFORM: {
          offset: 8,
          len: 1,
          values: Object.values(RANK_SCRIPT_PARTS.PLATFORM),
        },
        PROFILE: { offset: 10, len: 16 }, // As long as it is 16 bytes it is good
      },
      optional: {
        POST: { offset: 26, len: 32 }, // sha256 hash of post metadata + body, if applicable
        COMMENT: { offset: 58, len: 164 }, // optional on-chain comment to accompany vote (223 bytes - 59 bytes)
      },
    }
  }
  /**
   *
   * @param data
   * @returns
   */
  private toLogEntries(data: Block | RankTransaction): IndexerLogEntry[] {
    return Object.entries(data).map(([k, v]) => [k, String(v)])
  }
  /**
   * Perform all required operations to initialize the indexer and sync with lotusd
   */
  async init() {
    // signal handlers
    process.on('SIGINT', this.close)
    process.on('SIGTERM', this.close)
    /**
     *    Initialize Modules
     */
    // connect db
    await this.db.connect()
    log([
      ['init', 'database'],
      ['status', 'connected'],
    ])
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
      return this.close(ERR.NNG_CONNECT, e.message)
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
    try {
      const t0 = performance.now()
      const mempooltxs = await this.db.getRankTransactionsByHeight(null)
      if (mempooltxs.length > 0) {
        const profiles = this.toProfileMap(mempooltxs)
        await this.db.rewindProfiles(profiles)
        const t1 = (performance.now() - t0).toFixed(3)
        log([
          ['init', 'cleanup'],
          ['txsLength', `${mempooltxs.length}`],
          ['action', 'rewindProfiles'],
          ['elapsed', `${t1}ms`],
        ])
      }
    } catch (e) {
      return this.close(ERR.IDX_PROFILE_REWIND, e.message)
    }
    /**
     *    Reconcile Checkpoint
     */
    try {
      // Get current checkpoint height/hash for init, otherwise start at genesis
      const checkpoint =
        (await this.db.getCheckpoint()) ?? (GENESIS_BLOCK_V1 as Block)
      this.checkpoint = await this.initReconcileBlockState(checkpoint)
    } catch (e) {
      return this.close(ERR.IDX_BLOCKS_REWIND, e.message)
    }
    // Log our current checkpoint (i.e. best block)
    log([['init', 'best'], ...this.toLogEntries(this.checkpoint)])
    // Sync blocks
    try {
      await this.initSyncBlocks()
    } catch (e) {
      return this.close(ERR.IDX_BLOCKS_SYNC, e.message)
    }
    // Sync mempool
    try {
      const ranks = await this.initSyncMempool()
      // Initialize the mempool queue with these RANK txs
      ranks.forEach(rank => this.mempool.set(rank.txid, rank))
    } catch (e) {
      return this.close(ERR.IDX_MEMPOOL_SYNC, e.message)
    }
    // Subscribe to required NNG channels
    const channels = [
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
   * Make sure our checkpoint block matches lotusd at `height`, and rewind all database state as necessary
   */
  async initReconcileBlockState(checkpoint: Block) {
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
      // best block tip is 2 blocks ahead
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
   * Synchronize database state with lotusd, starting from `this.checkpoint`
   */
  async initSyncBlocks() {
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
   * Synchronize database state with current lotusd mempool
   */
  async initSyncMempool() {
    const t0 = performance.now()
    const entries: IndexerLogEntry[] = [['init', 'syncMempool']]
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
   * Disconnect all endpoints and exit program
   * @param exitCode Process signal as `string` or `(enum) ERR` value if fatal error
   * @param exitError Debug string if fatal error
   */
  async close(exitCode: number | string, exitError?: string): Promise<void> {
    // ignore shutdown() number since we're exiting anyway
    this.pub?.shutdown(this.pubUri)
    this.pub?.close()
    this.rpc?.shutdown(this.rpcUri)
    this.rpc?.close()
    await this.db?.disconnect()
    if (exitError?.length) {
      log([
        ['shutdown', 'fatal'],
        ['error', `${ERR[exitCode]}`],
        [`code`, `${exitCode}`],
        [`debug`, `${exitError}`],
      ])
    } else {
      log([
        ['shutdown', 'clean'],
        ['signal', `${exitCode}`],
      ])
    }
    // Next time the check queue is processed, we will exit
    // SIGINT/SIGTERM are clean shutdowns; if exitCode == string then exitCode == 0
    setImmediate(() => process.exit(typeof exitCode == 'string' ? 0 : exitCode))
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
      // Rewind profile states accordingly and delete block
      await this.db.deleteBlockByHeight(height)
      return ranks.length
    } catch (e) {
      throw new Error(`rewindBlock(${height}: ${e.message}`)
    }
  }
  /**
   * Process the oldest `NNGPendingMessageProcessor` in the queue
   * @param recursing
   * @returns {Promise<void>}
   */
  private nngProcessMessage = async (recursing = false): Promise<void> => {
    // Consecutive queued handlers need to wait their turn
    // But we bypass for recursive calls
    if (this.queue.busy && !recursing) {
      return
    }
    // Exclusive attention to the next-in-line (i.e. oldest) queued handler
    this.queue.busy = true
    try {
      const [NNGMessageProcessor, ByteBuffer] = this.queue.pending.shift()
      await NNGMessageProcessor(ByteBuffer)
    } catch (e) {
      return await this.close(ERR.NNG_PROCESS_MESSAGE, e.message)
    }
    // Recursively process queue if necessary
    if (this.queue.pending.length > 0) {
      return this.nngProcessMessage(true)
    }
    // Queue is finished processing all pending handlers
    this.queue.busy = false
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
    // Set immediate processing of the message queue
    setImmediate(this.nngProcessMessage)
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
    const txRawArray = mempooltx.tx().rawArray()
    const tx = new Transaction(Buffer.from(txRawArray))
    const rank = this.toRankTransaction(tx)
    if (rank) {
      const profiles = this.toProfileMap([rank])
      await this.db.upsertProfiles(profiles)
      const t1 = (performance.now() - t0).toFixed(3)
      // Keep this RANK tx to reconcile with next block
      this.mempool.set(rank.txid, rank)
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
    const entries: IndexerLogEntry[] = [['nng', 'blkconnected']]
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
    let profiles: ReturnType<typeof this.toProfileMap> = new Map()
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
    entries.push(['elapsed', `${t1}ms`])
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
    // Set up disconnected block for comparison to current best (checkpoint)
    const disconnectedBlock =
      NNG.BlockDisconnected.getRootAsBlockDisconnected(bb).block()
    const block = this.toBlock(disconnectedBlock.header(), true)
    // Rewind the current block
    const txsLength = await this.rewindBlock(block.height)
    const t1 = (performance.now() - t0).toFixed(3)
    // Get the current checkpoint from the database
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
  private processBlockOrMempool(data: NNG.Block | NNG.GetMempoolResponse) {
    const ranks: RankTransaction[] = []
    const txsLength = data.txsLength()
    const block = data instanceof NNG.Block ? this.toBlock(data.header()) : null
    // skip coinbase tx if processing block data
    for (let i = block ? 1 : 0; i < txsLength; i++) {
      try {
        const txRaw = data.txs(i).tx().rawArray()
        // Convert Uint8Array to Buffer else bitcore parse will fail
        const tx = new Transaction(Buffer.from(txRaw))
        // Try to convert to RANK tx; keep if successful
        const rank = this.toRankTransaction(tx, block)
        if (rank) {
          ranks.push(rank)
        }
      } catch (e) {
        throw new Error(`processBlockOrMempool(${typeof data}): ${e.message}`)
      }
    }
    return ranks
  }
  /**
   * Convert Bitcore `Transaction.Output[]` into a `RankTransaction`, using `Block` data if applicable
   * @param tx Bitcore `Transaction`
   * @param block `Block` converted from `NNG.BlockHeader`
   * @returns {RankTransaction}
   */
  private toRankTransaction(
    tx: Transaction,
    block: Block = null,
  ): RankTransaction {
    const outputs = this.processTransactionOutputs(tx.outputs)
    if (outputs.length > 0) {
      const rank: RankTransaction = {
        txid: tx.txid,
        timestamp: block?.timestamp ?? BigInt(Date.now()),
        ...outputs.shift(), // Only first output has RankTransaction data
      }
      // Add height if tx is confirmed
      if (block?.height) {
        rank.height = block.height
      }
      return rank
    }
    return null
  }
  /**
   * Parse the Bitcore-compatible transaction for RANK outputs and return all `RankTransaction` objects
   * @param tx Transaction object in Bitcore format
   * @returns {RankOutputs[]} Array of `RankTransaction` objects
   */
  private processTransactionOutputs(
    outputs: Transaction.Output[],
  ): RankOutput[] {
    const ranks: RankOutput[] = []
    try {
      for (let outIdx = 0; outIdx < outputs.length; outIdx++) {
        const output = outputs[outIdx]
        // Return RANK output array with 0 or more items
        if (!this.isRankScript(output.script)) {
          return ranks
        }
        ranks.push(this.toRankOutput(output))
      }
      // tx may not have change output; return all RANK outputs we found
      return ranks
    } catch (e) {
      throw new Error(
        `processTransactionOutputs(${typeof outputs}): ${e.message}`,
      )
    }
  }
  /**
   * Check if the provided output `script` is a RANK script
   * @param script Bitcore `Script`
   * @returns {false | Buffer}
   */
  private isRankScript(script: Script): false | Buffer {
    // we only care about OP_RETURN outputs
    if (!script.isDataOut()) {
      return false
    }
    const scriptBuf = script.toBuffer()
    // make sure the script has all required bytes
    if (scriptBuf.length < RANK_SCRIPT_MIN_BYTE_LENGTH) {
      return false
    }
    // validate all required parameters for RANK script parts
    for (const part of Object.values(this.parts.required)) {
      const hex = this.getScriptPart(part, scriptBuf, 'hex')
      if (
        // script part value is invalid, if applicable
        (part.values && !part.values.includes(hex)) ||
        // script part byte length does not meet requirement
        Buffer.from(hex, 'hex').length != part.len
      ) {
        return false
      }
    }
    // valid RANK output confirmed; return for processing
    return scriptBuf
  }
  /**
   * Parse the provided `scriptBuf` for the ScriptPart data, encoded as hex or UTF-8
   * @param part {ScriptPart} The ScriptPart for which to parse
   * @param scriptBuf {Buffer} The script buffer (`OP_RETURN` output only)
   * @returns {string}
   */
  private getScriptPart(
    part: ScriptPart,
    scriptBuf: Buffer,
    encoding: 'utf-8' | 'hex',
  ): string {
    return scriptBuf
      .subarray(part.offset, part.offset + part.len)
      .toString(encoding)
  }
  /**
   * Convert raw `Transaction.Output` to RANK output
   * @param output Transaction output in Bitcore-compatible format
   * @returns {RankOutput}
   */
  private toRankOutput(output: Transaction.Output): RankOutput {
    const parts = this.parts.required
    const scriptBuf = output.script.toBuffer()
    const platform = this.getScriptPart(parts.PLATFORM, scriptBuf, 'hex')
    const profileId = this.getScriptPart(parts.PROFILE, scriptBuf, 'hex')
    const sentiment = this.getScriptPart(parts.SENTIMENT, scriptBuf, 'hex')
    const sats = BigInt(output.satoshis)
    return { platform, profileId, sats, sentiment }
  }
  /**
   * Parse raw `NNG.Hash` flatbuffer for the 32-byte block hash or txid
   * @param hash Raw `NNG.Hash`
   * @returns {string} Block hash or txid as hex string (little endian)
   */
  private toBlockhashOrTxid(hash: NNG.Hash): string {
    const hashBuf = Buffer.alloc(32)
    for (let i = 0; i < 32; i++) {
      const byte = hash.data(i)
      hashBuf.writeUInt8(byte, i)
    }
    // reverse for little endian
    return hashBuf.reverse().toString('hex')
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
    const map: ProfileMap = new Map()
    // Sort the RANK txs for upsert
    ranks.forEach(rank => {
      // Determine positive/negative stats per RANK sentiment
      let ranking: bigint
      let votesPositive: number
      let votesNegative: number
      // Do a switch here in case sentiment is more than binary in the future
      switch (rank.sentiment) {
        case RANK_SCRIPT_PARTS.SENTIMENT.POSITIVE:
          ranking = rank.sats
          votesPositive = 1
          votesNegative = 0
          break
        case RANK_SCRIPT_PARTS.SENTIMENT.NEGATIVE:
          ranking = -rank.sats
          votesPositive = 0
          votesNegative = 1
          break
      }
      const { profileId: id, platform, ...partialRank } = rank
      const profile = map.get(id)
      if (profile) {
        profile.ranks.push(partialRank)
        profile.ranking += ranking
        profile.votesPositive += votesPositive
        profile.votesNegative += votesNegative
        return
      }
      map.set(rank.profileId, {
        id,
        platform,
        ranks: [partialRank],
        ranking,
        votesPositive,
        votesNegative,
      })
    })
    return map
  }
}
