import { Script, Transaction } from '@abcpros/bitcore-lib-xpi'
import { Builder, ByteBuffer } from 'flatbuffers'
import { isIP } from 'validator'
import * as NNG from './lib/nng-interface'
import { Socket, socket } from 'nanomsg'
import Database from './lib/database'
import {
  toProfileUTF8,
  toPlatformUTF8,
  toSentimentUTF8,
  log,
} from '@lotusia/rank-suite/util/functions'
import {
  RANK_SCRIPT_CHUNKS,
  RANK_SCRIPT_MIN_BYTE_LENGTH,
  NNG_PUB_DEFAULT_SOCKET_PATH,
  NNG_RPC_DEFAULT_SOCKET_PATH,
  NNG_REQUEST_TIMEOUT_LENGTH,
  NNG_RPC_BLOCKRANGE_SIZE,
  NNG_RPC_RCVMAXSIZE_CONSENSUS,
  NNG_SOCKET_MAXRECONN,
  NNG_SOCKET_RECONN,
  ERR,
  RANK_BLOCK_GENESIS_V1,
} from '@lotusia/rank-suite/util/constants'
import type {
  IndexerLogEntry,
  RankOutput,
  RankTransaction,
  Block,
  ProfileMap,
  ScriptChunk,
  ScriptChunkField,
  ScriptChunkSentimentUTF8,
} from '@lotusia/rank-suite'
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
export default class Indexer {
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
      [chunk in Exclude<ScriptChunkField, 'POST' | 'COMMENT'>]: ScriptChunk
    }
    optional: {
      [chunk in Extract<ScriptChunkField, 'POST' | 'COMMENT'>]: ScriptChunk
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
          throw new Error(
            `protocol tcp expects valid IP address, got "${invalidIP}"`,
          )
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
          map: RANK_SCRIPT_CHUNKS.LOKAD,
        },
        SENTIMENT: {
          offset: 6,
          len: 1,
          map: RANK_SCRIPT_CHUNKS.SENTIMENT,
        },
        PLATFORM: {
          offset: 8,
          len: 1,
          map: RANK_SCRIPT_CHUNKS.PLATFORM,
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
      return this.close(ERR.IDX_PROFILE_REWIND, e.message)
    }
    /**
     *    Reconcile Checkpoint
     */
    try {
      // Get current checkpoint height/hash for init, otherwise start at genesis
      const checkpoint =
        (await this.db.getCheckpoint()) ?? (RANK_BLOCK_GENESIS_V1 as Block)
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
  private nngProcessMessage = async (): Promise<void> => {
    // Queue is now busy processing queued NNG handlers
    // Prevents clobbering; maintains healthy database state
    this.queue.busy = true
    try {
      // Oldest queued handler/message is processed first
      const [NNGMessageProcessor, ByteBuffer] = this.queue.pending.shift()
      await NNGMessageProcessor(ByteBuffer)
    } catch (e) {
      // Should never get here; shut down if we do
      return await this.close(ERR.NNG_PROCESS_MESSAGE, e.message)
    }
    // Recursively process queue if necessary
    if (this.queue.pending.length > 0) {
      return this.nngProcessMessage()
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
    const output = this.processTransactionOutputs(tx.outputs)
    if (output) {
      const rank = {
        txid: tx.txid,
        timestamp: mempooltx.time(),
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
        // Process tx outputs for RANK outputs; convert any to RANK txs
        const output = this.processTransactionOutputs(tx.outputs)
        if (output) {
          ranks.push({
            txid: tx.txid,
            height: block?.height,
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
   * Parse the Bitcore-compatible tx outputs for RANK outputs and return them
   * @param outputs Transaction `output` array in Bitcore format
   * @returns {RankOutputs} Processed RANK output(s), or null if none found
   */
  private processTransactionOutputs(outputs: Transaction.Output[]): RankOutput {
    try {
      // first output MUST be RANK output, else invalid
      if (!this.isRankScript(outputs[0].script)) {
        return null
      }
      const rank = this.parseRawRankOutput(outputs[0])
      // TODO: additional processing for RANK extension outputs

      // Return processed output(s)
      return rank
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
  private isRankScript(script: Script): boolean {
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
      const partBuf = this.getScriptChunk(part, scriptBuf)
      if (
        // script part value is invalid, if applicable
        // need to read in big endian for SCRIPT_CHUNK map keys
        // e.g. 0x52414e4b == 1380011595 (big endian / nodejs)
        //      0x52414e4b == 1263419730 (little endian / lotusd)
        (part.map && !part.map.has(partBuf.readUIntBE(0, part.len))) ||
        // script part byte length does not meet requirement
        partBuf.length != part.len
      ) {
        return false
      }
    }
    // valid RANK output confirmed
    return true
  }
  /**
   * Parse the provided `scriptBuf` for the ScriptChunk data, encoded as hex or UTF-8
   * @param part {ScriptChunk} The ScriptChunk for which to parse
   * @param scriptBuf {Buffer} The script buffer (`OP_RETURN` output only)
   * @returns {Buffer}
   */
  private getScriptChunk(part: ScriptChunk, scriptBuf: Buffer): Buffer {
    return scriptBuf.subarray(part.offset, part.offset + part.len)
  }
  /**
   * Convert raw Bitcore RANK output to `RankOutput` object
   * @see {@linkcode RankOutput}
   * @param output RANK output in Bitcore format
   * @returns {RankOutput}
   */
  private parseRawRankOutput(output: Transaction.Output): RankOutput {
    const parts = this.parts.required
    const scriptBuf = output.script.toBuffer()
    const platformBuf = this.getScriptChunk(parts.PLATFORM, scriptBuf)
    const profileIdBuf = this.getScriptChunk(parts.PROFILE, scriptBuf)
    const sentimentBuf = this.getScriptChunk(parts.SENTIMENT, scriptBuf)
    const sats = BigInt(output.satoshis)
    return {
      platform: toPlatformUTF8(platformBuf).toLowerCase(),
      profileId: toProfileUTF8(profileIdBuf).toLowerCase(),
      sentiment: toSentimentUTF8(sentimentBuf).toLowerCase(),
      sats,
    }
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
      switch (rank.sentiment as Lowercase<ScriptChunkSentimentUTF8>) {
        case 'positive':
          ranking = rank.sats
          votesPositive = 1
          votesNegative = 0
          break
        case 'negative':
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
