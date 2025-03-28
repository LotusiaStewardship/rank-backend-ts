import { Chunk, Transaction } from '@abcpros/bitcore-lib-xpi'
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
} from '../submodules/rank-lib'
import {
  ERR,
  NNG_PUB_DEFAULT_SOCKET_PATH,
  NNG_RPC_DEFAULT_SOCKET_PATH,
  NNG_REQUEST_TIMEOUT_LENGTH,
  NNG_RPC_BLOCKRANGE_SIZE,
  NNG_RPC_RCVMAXSIZE_CONSENSUS,
  NNG_SOCKET_MAXRECONN,
  NNG_SOCKET_RECONN,
} from '../util/constants'
import {
  PLATFORMS,
  RANK_BLOCK_GENESIS_V1,
  RANK_OUTPUT_MIN_VALID_SATS,
  RANK_SCRIPT_CHUNKS,
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
  private db: Database
  private pub: Socket
  private rpc: Socket
  private pubUri: string
  private rpcUri: string
  private mempool: MempoolCache
  private queue: NNGQueue
  private chunks: {
    required: {
      [chunk in Exclude<ScriptChunkField, 'post' | 'comment'>]: ScriptChunk
    }
    optional: {
      [chunk in Extract<ScriptChunkField, 'post' | 'comment'>]: ScriptChunk
    }
  }
  private checkpoint: Block
  /**
   *
   * @param pubUri
   * @param rpcUri
   */
  constructor(db: Database, pubUri?: string, rpcUri?: string) {
    super()
    // Validate NNG parameters
    this.pubUri = pubUri
      ? `ipc://${resolve(pubUri)}`
      : `ipc://${resolve(NNG_PUB_DEFAULT_SOCKET_PATH)}`
    this.rpcUri = rpcUri
      ? `ipc://${resolve(rpcUri)}`
      : `ipc://${resolve(NNG_RPC_DEFAULT_SOCKET_PATH)}`
    // Module setup
    this.db = db
    // Pub/Sub socket setup
    this.pub = socket('sub', { chan: [] })
    this.pub.on('data', this.nngReceiveMessage)
    this.pub.rcvmaxsize(NNG_RPC_RCVMAXSIZE_CONSENSUS)
    this.pub.reconn(NNG_SOCKET_RECONN)
    this.pub.maxreconn(NNG_SOCKET_MAXRECONN)
    // RPC socket setup
    this.rpc = socket('req')
    this.rpc.rcvmaxsize(NNG_RPC_RCVMAXSIZE_CONSENSUS * NNG_RPC_BLOCKRANGE_SIZE)
    this.rpc.reconn(NNG_SOCKET_RECONN)
    this.rpc.maxreconn(NNG_SOCKET_MAXRECONN)
    // Runtime state setup
    this.mempool = new Map()
    this.queue = { busy: false, pending: [] }
    this.chunks = {
      required: {
        lokad: RANK_SCRIPT_CHUNKS.lokad,
        sentiment: RANK_SCRIPT_CHUNKS.sentiment,
        platform: RANK_SCRIPT_CHUNKS.platform,
        profile: RANK_SCRIPT_CHUNKS.profile, // As long as it is 16 bytes it is good
      },
      optional: {
        post: RANK_SCRIPT_CHUNKS.post, // post ID
        comment: RANK_SCRIPT_CHUNKS.comment, // optional on-chain comment to accompany vote (223 bytes - 59 bytes)
      },
    }
  }
  /**
   *
   * @param data
   * @returns
   */
  private toLogEntries(data: Block | RankTransaction): LogEntry[] {
    return Object.entries(data).map(([k, v]) => [k, String(v)])
  }
  /**
   * Perform all required operations to initialize the indexer and sync with lotusd
   */
  async init() {
    /**
     *    Initialize Modules
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
      // Get current checkpoint height/hash for init, otherwise start at genesis
      const checkpoint =
        (await this.db.getCheckpoint()) ?? (RANK_BLOCK_GENESIS_V1 as Block)
      this.checkpoint = await this.initReconcileBlockState(checkpoint)
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
   * Disconnect all endpoints and exit program
   * @param exitCode Process signal as `string` or `(enum) ERR` value if fatal error
   * @param exitError Debug string if fatal error
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
   * Recursively process queued `NNGMessageProcessor` methods and their associated `ByteBuffer` data
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
      this.emit('exception', ERR.NNG_PROCESS_MESSAGE, e.message)
      return
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
    // silently ignore RANK txs that send change to a different address
    const scriptPayload = this.getScriptPayload(tx)
    if (!scriptPayload) {
      return
    }
    const output = this.processTransactionOutputs(tx.outputs)
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
        // Process tx outputs for RANK outputs; convert any to RANK txs
        const output = this.processTransactionOutputs(tx.outputs)
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
   * Parse the Bitcore-compatible tx outputs for RANK outputs and return them
   * @param outputs Transaction `output` array in Bitcore format
   * @returns {RankOutput} Processed RANK output, or null if none found
   */
  private processTransactionOutputs(outputs: Transaction.Output[]): RankOutput {
    try {
      const { script, satoshis } = outputs[0]
      // first output script MUST be OP_RETURN else ignore
      if (!script.isDataOut()) {
        return null
      }
      // OP_RETURN output value MUST be >= defined minimum
      if (satoshis < RANK_OUTPUT_MIN_VALID_SATS) {
        return null
      }
      // exclude OP_RETURN chunk and make sure remaining chunk count is valid
      // chunks array is COPIED via .slice() so is SAFE to shift/splice/etc.
      const chunks = script.chunks.slice(1)
      const required = Object.values(this.chunks.required)
      if (chunks.length < required.length) {
        return null
      }
      // verify script chunks contain valid hard-coded chunk parameters
      // this also inherently validates script chunk order
      for (let i = 0; i < required.length; i++) {
        const chunk = required[i]
        if (!chunk.map) {
          continue
        }
        // sentiment does not get parsed by bitcore into buf; convert opcodenum to buf
        if (!chunks[i].buf) {
          // put opcodenum in an array before Buffer.from
          chunks[i].buf = Buffer.from([chunks[i].opcodenum])
          chunks[i].len = chunks[i].buf.length
        }
        if (!chunk.map.has(chunks[i].buf.readUintBE(0, chunks[i].len))) {
          return null
        }
      }
      // gather parameters for platform
      const platformChunk = this.chunks.required.platform
      const platform = platformChunk.map.get(
        chunks[2].buf.readUIntBE(0, platformChunk.len),
      ) as ScriptChunkPlatformUTF8
      const { profileId } = PLATFORMS[platform]
      // script chunk after platform MUST be profile and be padded to required length
      if (chunks[3].len < profileId.len) {
        return null
      }
      // splice original chunk array to remove all required chunks
      // then remove lokad chunk to process remaining required chunks into RankOutput
      const rank = this.processScriptChunks(
        chunks.splice(0, required.length).slice(1),
      )
      // Process optional chunks
      if (chunks.length > 0) {
        const { postId } = PLATFORMS[platform]
        for (let i = 0; i < chunks.length; i++) {
          let decoded: string
          const chunk = chunks[i]
          switch (i) {
            // postId or comment
            case 0:
              try {
                // match platform postId requirements, otherwise assume comment data
                decoded = chunk.buf[postId.reader]().toString()
              } catch (e) {
                // we really ought not skip errors here..
                // if a user cast a vote, we need to process their vote correctly
                // e.g. old Twitter post IDs are 64-bit UInt, but old post IDs aren't 8-byte length
                // ref: https://x.com/DianeP89/status/810184088212701184 is 7-byte length
                //
                //
                // A bugfix is needed for this; for now, just break and leave `rank.postId` undefined
                break
              }
              if (
                chunk.len == postId.chunkLength &&
                decoded.match(postId.regex)
              ) {
                rank.postId = decoded
              } else {
                // TODO: replace with instanceId
                //rank.comment = toCommentUTF8(chunk.buf)
              }
              break
            // comment
            case 1:
              // TODO: replace with instanceId
              //rank.comment = toCommentUTF8(chunk.buf)
              break
          }
        }
      }
      // Return processed output(s)
      return rank
    } catch (e) {
      throw new Error(
        `processTransactionOutputs(${typeof outputs}): ${e.message}`,
      )
    }
  }
  /**
   * Process the transaction inputs to get the 20-byte, hex-encoded `scriptPayload`
   * @param tx
   * @returns
   */
  private getScriptPayload(tx: Transaction): string | void {
    if (
      tx.inputs.every(
        (input, idx, array) =>
          array[0].script
            .toAddress()
            .hashBuffer.compare(input.script.toAddress().hashBuffer) === 0,
      )
    ) {
      return tx.inputs[0].script.toAddress().hashBuffer.toString('hex')
    }
  }
  /**
   * Convert required RANK output chunks to `RankOutput` object
   * @param chunks Bitcore script chunk array
   * @returns {RankOutput}
   * @see {@linkcode RankOutput}
   */
  private processScriptChunks(chunks: Chunk[]): RankOutput {
    return {
      sentiment: toSentimentUTF8(chunks.shift().buf).toLowerCase(),
      platform: toPlatformUTF8(chunks.shift().buf).toLowerCase(),
      profileId: toProfileIdUTF8(chunks.shift().buf).toLowerCase(),
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
