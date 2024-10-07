import { Script, Transaction } from '@abcpros/bitcore-lib-xpi'
import { Builder, ByteBuffer } from 'flatbuffers'
import * as NNG from './nng-interface'
import { Socket, socket } from 'nanomsg'
//import { Socket } from '@rustup/nng'
import { Database } from './database'
import {
  ERR,
  NNG_REQUEST_TIMEOUT_LENGTH,
  NNG_RPC_BLOCKRANGE_SIZE,
  NNG_RPC_RCVMAXSIZE_CONSENSUS,
  NNG_SOCKET_MAXRECONN,
  NNG_SOCKET_RECONN,
} from '../util/constants'
/** First block with a RANK transaction */
const GENESIS = {
  hash: '00000000019cc1ddc04bc541f531f1424d04d0c37443867f1f6137cc7f7d09e5',
  height: 811624,
  timestamp: 1721079817n
}
/**  */
export type NNGMessageType = 
  'mempooltxadd' |
  'mempooltxrem' |
  'blkconnected' |
  'blkdisconctd'
/**  */
export type ScriptPart = {
  offset: number,
  len: number,
  hex?: string,
}
/**  */
export type ParsedTransaction = {
  txid: string,
  timestamp: Date // unix
  outputs: Transaction.Output[]
}
/** OP_RETURN <RANK> <sentiment> <profileId> [<postId> <commentHex>] */
type RankOutput = {
  platform: string // e.g. Twitter/X.com
  profileId: string // who the ranking is for
  sentiment: boolean // true = positive, false = negative
  value: bigint // sats for sentiment
}
/**  */
export type RankTransaction = RankOutput & {
  output: string // <txid>_<outIdx>
  height: number // -1 if mempool
  timestamp: bigint // unix timestamp
}
/**  */
export type Profile = {
  // 16-byte hex-encoded profile name (e.g. "mcp011011" -> "000000000000006d6370303131303131")
  id: string
  // 1-byte hex-encoded platform code (e.g. Twitter -> "01")
  platform: string 
  ranks: RankTransaction[]
  ranking?: bigint // ranking needs to be calculated after upserts
}
/** */
export type Block = {
  height: number,
  timestamp: bigint,
  hash: string,
  prevhash?: string, // for reorg checks only; does not get saved to database
  ranksLength: number // default is 0 unless a block is based
}
/**  */
enum QUEUE_STATE {
  FREE = 0,
  BUSY = 1,
}
/** Signal to would-be promises that they should think twice before resolving */
export class Indexer {
  private db: Database
  private sub: Socket
  private rpc: Socket
  private nngUri: string
  private rpcUri: string
  private queue: {
    state: QUEUE_STATE,
    promises: Promise<any>[]
  } = {
    state: QUEUE_STATE.FREE,
    promises: []
  }
  private parts: {
    [part in 'lokad' | 'sentiment' | 'platform' | 'profile' | 'post' | 'comment']: ScriptPart
  } = {
    lokad: { offset: 2, len: 4, hex: Buffer.from('RANK').toString('hex') },
    sentiment: { offset: 6, len: 1 },
    platform: { offset: 8, len: 1 },
    profile: { offset: 10, len: 16 },
    post: { offset: 26, len: 32 }, // sha-256 hash of post metadata + body, if applicable
    comment: { offset: 58, len: 164 } // optional on-chain comment to accompany vote (223 bytes - 59 bytes)
  }
  private genesis: Block = {
    ...GENESIS,
    ranksLength: 1
  }
  private checkpoint: Block
  /**
   * 
   * @param nngUri 
   * @param rpcUri 
   */
  constructor(
    nngUri: string,
    rpcUri: string
  ) {
    this.db = new Database()
    this.nngUri = nngUri
    this.rpcUri = rpcUri
    // Pub/Sub socket setup
    this.sub = socket('sub', { chan: [] })
    this.sub.on('error', this.close)
    this.sub.on('data', this.nngData)
    this.sub.rcvmaxsize(NNG_RPC_RCVMAXSIZE_CONSENSUS)
    this.sub.reconn(NNG_SOCKET_RECONN)
    this.sub.maxreconn(NNG_SOCKET_MAXRECONN)
    // RPC socket setup
    this.rpc = socket('req')
    this.rpc.on('error', this.close)
    this.rpc.rcvmaxsize(NNG_RPC_RCVMAXSIZE_CONSENSUS * NNG_RPC_BLOCKRANGE_SIZE)
    this.rpc.reconn(NNG_SOCKET_RECONN)
    this.rpc.maxreconn(NNG_SOCKET_MAXRECONN)
  }
  /**
   * Start the engines!
   */
  async init() {
    let log = 'MAIN[init()]: '
    // signal handlers
    process.on('SIGINT', this.close)
    process.on('SIGTERM', this.close)
    // connect db
    await this.db.connect()
    // Connect NNG sockets to their respective URIs
    // TODO: Need to actually detect NNG connectivity... refer to todo.txt
    try {
      this.rpc.connect(this.rpcUri)
      this.sub.connect(this.nngUri)
      if (!this.rpc.connected || !this.sub.connected) {
        throw new Error(`NNG failed to connect. Make sure NNG is enabled in your lotus.conf and try again.`)
      }
    } catch (e: any) {
      this.close(
        ERR.NNG_CONNECT,
        `MAIN[init()]: ${e.message}`
      )
    }
    // If there are lingering unconfirmed RANK txs, clear them out now
    const mempooltxs = await this.db.getRankTransactionsByHeight(-1)
    if (mempooltxs.length > 0){
      try {
        const result = await this.rewindProfiles(mempooltxs)
        console.log(log + result)
      } catch (e: any) {
        this.close(
          ERR.IDX_PROFILE_REWIND,
          log + e.message
        )
      }
    }
    // Get current checkpoint height/hash for init, otherwise start at genesis
    const { hash, height } = await this.db.getCheckpoint() ?? this.genesis
    console.log(log + `current checkpoint: ${hash} (height ${height})`)
    // Get the best block compared to our checkpoint
    // The best block could be a previous block with a different hash
    const best = await this.getBestBlock(hash, height)
    // Check for reorgs
    if (
      best.height < height ||
      hash != best.hash && best.height == height ||
      hash != best.prevhash && best.height == (height + 1)
    ) {
      console.log(
        log + ` --- ! REORG DETECTED\r\n`
      + log + ` --- !    checkpoint best: ${hash} (height ${height})\r\n`
      + log + ` --- !           RPC best: ${best.hash} (height ${best.height})\r\n`
      + log + ` --- !       RPC prevhash: ${best.prevhash} (height ${best.height - 1})`)
      // rewind backwards to match checkpoint height/hash to RPC
      try {
        await this.rewindBlocks(height, best.height)
      } catch (e: any) {
        this.close(
          ERR.IDX_BLOCKS_REWIND,
          log + e.message
        )
      }
    }
    // Sync to the chain tip, starting with the block after our current height
    try {
      const t0 = performance.now()
      // checkpoint is latest synced block or current best (if already synced)
      this.checkpoint = await this.syncBlocks(best.height + 1) ?? best
      const t1 = ((performance.now() - t0) / 1000).toFixed(3)
      console.log(log + `synced with RPC: ${this.checkpoint.hash} (height: ${this.checkpoint.height})`)
      console.log(log + `processed ${this.checkpoint.height - best.height} total blocks (${t1}s)`)
    } catch (e: any) {
      this.close(
        ERR.IDX_BLOCKS_SYNC,
        log + e.message
      )
    }
    // Sync the mempool now, just in case we missed anything 😋
    try {
      const result = await this.syncMempool()
      console.log(log + result)
    } catch (e: any) {
      this.close(
        ERR.IDX_MEMPOOL_SYNC,
        log + e.message
      )
    }
    // Add the `mempooltxadd` and 'blkconnected' NNG channels
    this.sub.chan(['mempooltxadd', 'blkconnected'])
    console.log(log + `subscribed to NNG and awaiting messages`)
  }
  /**
   * Shutdown established connections and close the NNG socket
   * @returns {void}
   */
  async close(
    exitCode: number = 0,
    exitError?: string
  ): Promise<NodeJS.Immediate> {
    //clearInterval(this.processingInterval)
    // ignore shutdown() number since we're exiting anyway
    this.sub?.shutdown(this.nngUri)
    this.rpc?.shutdown(this.rpcUri)
    this.sub?.close()
    this.rpc?.close()
    await this.db?.disconnect()
    if (exitError?.length) { console.error(`FATAL: ${ERR[exitCode]} [${exitCode}]: ${exitError}`) }
    // Next time the check queue is processed, we will exit
    return setImmediate(() => process.exit(isNaN(Number(exitCode)) ? 1 : exitCode))
  }
  /**
   * Compare checkpoint `Block` against the RPC counterpart. Recurse backwards until a match is found.
   * @param checkpoint `Block` whose hash is compared to RPC at the same `height`
   * @returns {Promise<Block>} The best `Block` required to fully sync with RPC
   */
  private async getBestBlock(hash: string, height: number): Promise<Block> {
    // nanomsg library will block if there is a connection issue
    // nanomsg library will return if RPC responds
    const block = await this.rpcGetBlock(height)
    // block will be null if RPC didn't give us the block for the checkpoint height
    if (block) {
      const header = block.header()
      const rpcHash = this.toBlockhashOrTxid(header.blockHash().hash())
      if (rpcHash == hash) {
        // return RPC block as best
        return this.toBlock(header)
      }
    }
    // Either we didn't get a block from RPC or hash mismatch
    const prevblock = await this.db.getBlockByHeight(height - 1)
    return this.getBestBlock(prevblock.hash, prevblock.height)
  }
  /**
   * 
   * @param startHeight 
   * @param bestHeight 
   */
  private async rewindBlocks(
    startHeight: number,
    bestHeight: number
  ): Promise<void> {
    let log = 'MAIN[rewindBlocks()]: '
    for (let height = startHeight; height > bestHeight; height--) {
      // Gather RANK txs from this block
      const ranks = await this.db.getRankTransactionsByHeight(height)
      // Use "true" to tell this method to execute rewind query vs upsert query
      const result = await this.rewindProfiles(ranks)
      // Delete block
      await this.db.deleteBlockByHeight(height)
      console.log(log + ` --- ! height ${height}: ${result}`)
    }
  }
  /**
   * Called during reorg to revert RANK txs
   * @param ranks 
   */
  private async rewindProfiles(
    ranks: RankTransaction[]
  ) {
    const t0 = performance.now()
    const profiles = this.toProfiles(ranks)
    await this.db.rewindProfiles(profiles)
    const t1 = (performance.now() - t0).toFixed(3)
    return `rewound ${ranks.length} RANK outputs for ${profiles.length} profiles (${t1}ms)`
  }
  /**
   * Poll NNG over RPC for (up to) `NNG_RPC_BLOCKRANGE_SIZE` blocks and process them for `RANK` transactions.
   * This method is called recursively from within until RANK database is synced with the blockchain.
   * @param height 
   * @returns 
   */
  private async syncBlocks(
    height: number
  ): Promise<Block> { 
    let log = `MAIN[syncBlocks()]: `
    const t0 = performance.now()
    // Fetch and parse the range of blocks and get the total count
    const blockrange = await this.rpcGetBlockRange(height)
    const blocksLength = blockrange.blocksLength()
    // Already synced if no blocks returned from RPC
    if (blocksLength < 1) {
      return null
    }
    log += `height ${height}->${height + (blocksLength - 1)}: `
    // Prepare for processing the block range
    const blocks: Block[] = []
    const ranks: RankTransaction[] = []
    // Proceed with processing the block range
    for (let i = 0; i < blocksLength; i++) {
      const block = blockrange.blocks(i)
      const checkpoint = this.toBlock(block.header())
      const txsLength = block.txsLength()
      // Skip processing blocks with only coinbase tx or none at all
      // Keep block to update database checkpoint
      if (txsLength <= 1) {
        blocks.push(checkpoint)
        continue
      }
      const result = this.processTransactions(block)
      // Saving these for later
      blocks.push({ ...checkpoint, ranksLength: result.length })
      ranks.push(...result)
    }
    // Upsert profiles and include all associated RANK txs
    if (ranks.length > 0) {
      try {
        await this.upsertProfiles(ranks)
      } catch (e: any) {
        this.close(
          ERR.IDX_PROFILE_UPSERT,
          log + e.message
        )
      }
    }
    // Save blocks after RANK txs in case of error we can resync
    try {
      await this.db.saveBlocks(blocks)
    } catch (e: any) {
      console.error(log + e.message)
      this.close()
    }
    const t1 = (performance.now() - t0).toFixed(3)
    console.log(log + `processed ${ranks.length} RANK txs (${t1}ms)`)
    // If we didn't get a full range of blocks then we are fully synced
    // Return the latest block height/hash to update the checkpoint
    if (blocksLength < NNG_RPC_BLOCKRANGE_SIZE) {
      // At this point, any RPC call will likely only be for a single block
      // Set the rcvmaxsize appropriately (as of 9/24/24 block size per network policy is 2MB)
      this.rpc.rcvmaxsize(NNG_RPC_RCVMAXSIZE_CONSENSUS)
      // All done catching up; return latest block for logging status to console
      return blocks[blocks.length - 1]
    }
    // recursively sync the next range of blocks
    return this.syncBlocks(height + blocksLength)
  }
  /**
   * 
   */
  private async syncMempool() {
    const t0 = performance.now()
    const mempool = await this.rpcGetMempool()
    const txsLength = mempool.txsLength()
    if (txsLength < 1) {
      return `no mempool txs to process`
    }
    const ranks = this.processTransactions(mempool)
    if (ranks.length < 1) {
      return `no mempool RANK txs to process`
    }
    try {
      await this.upsertProfiles(ranks)
      const t1 = (performance.now() - t0).toFixed(3)
      return `processed ${ranks.length} mempool RANK txs (${t1}ms)`
    } catch (e: any) {
      throw new Error(e.message)
    }
  }
  /**
   * 
   * @param msg 
   * @returns 
   */
  private nngData = async (msg: Buffer): Promise<void> => {
    let log = 'NNG[nngMessage()]: '
    // Parse out the message type and convert message to ByteBuffer
    const msgType = msg.subarray(0, 12).toString() as NNGMessageType
    const bb = new ByteBuffer(msg.subarray(12))

    switch (msgType) {
      case 'mempooltxadd':
        // If the event loop isn't ready for us to pile on more promises, we need to gtfo
        if (this.queue.state != QUEUE_STATE.FREE) {
          return
        }
        log += 'mempooltxadd: '
        try {
          const mempooltx = NNG.TransactionAddedToMempool
            .getRootAsTransactionAddedToMempool(bb)
            .mempoolTx()
            .tx()
          const tx = new Transaction(Buffer.from(mempooltx.rawArray()))
          // If a reorg occurs, all txs from those blocks will trigger mempooltxadd
          // If any reorg'd block contains RANK txs, they will fail when adding to db
          // Need to first make sure the RANK tx doesn't exist before proceeding
          if (await this.db.isExistingTransaction(tx.txid)) {
            return
          }
          const ranks = this.processRawTransaction(tx)
          if (ranks.length > 0) {
            const result = await this.upsertProfiles(ranks)
            console.log(log + `${tx.txid}: ${result}`)
          }
        } catch (e: any) {
          throw new Error(log + e.message)
        }
        break
      case 'blkconnected':
        // Block processing has the highest priority in the event loop
        // This is a signal to other event listeners to think twice before resolving
        this.queue.state = QUEUE_STATE.BUSY
        log += 'blkconnected: '
        const connectedBlock = NNG.BlockConnected.getRootAsBlockConnected(bb)
        // Remove all conflicting txs from database
        // TODO: Will need to update Profile ranking values
        // 9/25/24: THIS CODE BLOCK IS CURRENTLY UNTESTED
        const tcl = connectedBlock.txsConflictedLength()
        if (tcl > 0) {
          for (let i = 0; i < tcl; i++) {
            const tx = connectedBlock.txsConflicted(i)
            const txid = this.toBlockhashOrTxid(tx.hash())
            await this.db.deleteRankTransactionsByTxid(txid)
            console.log(log + `${txid} deleted from db`)
          }
        }
        // include the prevhash when processing block header
        // this is for checking reorgs
        const block = connectedBlock.block()
        const prevhash = this.toBlockhashOrTxid(block.header().prevBlockHash().hash())
        let best = this.toBlock(block.header())
        // Check for reorgs and other stuff before processing
        // If we have to process reorg, then assume our current block/ranks 
        // TODO: probably need to copy this logic down to blkdisconctd
        const { height, hash } = this.checkpoint
        if (
          // new block height should be greater than checkpoint
          best.height < height ||
          // checkpoint hash should match new block prevhash and new height should be +1
          (hash != prevhash && (height + 1) == best.height) || 
          // tertiary case for testing w/ invalidateblock; forced chain split
          (hash != best.hash && height == best.height)
        ) {
          // REORG DETECTED
          console.log(
            log + ` --- ! BLOCKCHAIN DESYNC DETECTED -- POSSIBLE REORG\r\n`
          + log + ` --- !    checkpoint best: ${hash} (height ${height})\r\n`
          + log + ` --- !           RPC best: ${best.hash} (height ${best.height})\r\n`
          + log + ` --- !       RPC prevhash: ${prevhash} (height ${best.height - 1})`)
          // Fetch the best block hash/height to make sure we rewind accordingly
          best = await this.getBestBlock(hash, height)
          try {
            // Rewind unconfirmed transactions first
            const unconfirmed = await this.db.getRankTransactionsByHeight(-1)
            const result = await this.rewindProfiles(unconfirmed)
            console.log(log + ` --- ! height -1 (unconfirmed): ${result}`)
          } catch (e: any) {
            this.close(
              ERR.IDX_PROFILE_REWIND,
              log + e.message
            )
          }
          // Rewind blocks until best hash/height is reached
          try {
            await this.rewindBlocks(height, best.height)
          } catch (e: any) {
            this.close(
              ERR.IDX_BLOCKS_REWIND,
              log + e.message
            )
          }
          // Sync blocks after rewind
          try {
            await this.syncBlocks(best.height + 1)
          } catch (e: any) {
            this.close(
              ERR.IDX_BLOCKS_SYNC,
              log + e.message
            )
          }
          // Don't continue; assume all RANK tx processing would be invalid from this point
          // Queue is no longer busy; event listeners can process again
          this.queue.state = QUEUE_STATE.FREE
          return 
        }
        // Proceed normally if there is no reorg
        // Process block for any RANK txs
        const ranks = this.processTransactions(block)
        if (ranks.length > 0) {
          // Upsert all RANK txs that exist in the block but not in the database
          // This can happen because mempooltxadd doesn't always get triggered immediately for some reason
          const unconfirmed = await this.db.getRankTransactionsByHeight(-1)
          const missing = ranks.filter(q => unconfirmed.findIndex(u => u.output == q.output) < 0)
          if (missing.length > 0) {
            const result = await this.upsertProfiles(missing)
            console.log(log + result)
          }
          // Update all of the RANK txs from this block
          const t0 = performance.now()
          await this.db.updateRankTransactions(ranks)
          const t1 = (performance.now() - t0).toFixed(3)
          console.log(log + `confirmed ${ranks.length} RANK txs (${t1}ms)`)
        }

        // Save latest checkpoint
        await this.db.saveBlocks([{
          ...best,
          ranksLength: ranks.length
        }])
        console.log(log + `${best.hash} (height ${best.height})`)

        // TODO: we may need to add some additional state checks here, but maybe not

        // Update checkpoint to this block
        this.checkpoint = { ...best }
        this.queue.state = QUEUE_STATE.FREE
        break
      /**
       * 9/25/24: Not subscribed to these NNG channel messages
       * 
      // removed from mempool because it conflicts with tx in new block, reorg, etc.
      case 'mempooltxrem':
        try {
          // remove the tx from the db if it exists
        } catch (e: any) {

        }
        break
       */
        
      case 'blkdisconctd':
        try {
          const disconnectedBlock = NNG.BlockDisconnected.getRootAsBlockDisconnected(bb)
          const block = disconnectedBlock.block()

        } catch (e: any) {
          throw new Error(`nngMessageHandler: blkdisconctd: ${e.message}`)
        }

        break
    }
  }
  /**
   * Process RANK txs into Profile upserts and commit to the database
   * @param ranks 
   * @returns 
   */
  private async upsertProfiles(
    ranks: RankTransaction[]
  ) {
    const t0 = performance.now()
    const profiles = this.toProfiles(ranks)
    // Upsert each Profile + RANK txs + ranking increments/decrements
    await this.db.upsertProfiles(profiles)
    const t1 = (performance.now() - t0).toFixed(3)
    return `processed ${ranks.length} RANK outputs for ${profiles.length} profiles (${t1}ms)`
  }
  /**
   * Send RPC command to lotusd over NNG interface (`this.rpc`)
   * @param param0 Object containing `rpcType` property and optional object for specific request type
   * @returns {Promise<ByteBuffer>} The parsed `ByteBuffer` response for the specific RPC call, processed in other methods
   */
  private async rpcCall(
    rpcType: keyof typeof NNG.RpcRequest,
    params?: {
      blockRangeRequest?: { startHeight: number, numBlocks: number },
      blockRequest?: { height: number },
    }
  ): Promise<ByteBuffer> {
    // Make sure the RPC socket is connected
    // TODO: Need to actually make this work... refer to todo.txt
    if (!this.rpc.connected) {
      this.close(
        ERR.NNG_DISCONNECT,
        `MAIN[rpcCall()]: RPC socket is not connected (reconnect failure?)`
      )
    }
    const builder = new Builder()
    let offset = 0// placeholder
    switch (rpcType) {
      case "GetMempoolRequest":
        offset = NNG.GetMempoolRequest.createGetMempoolRequest(builder)
        break
      case "GetBlockRangeRequest":
        const { startHeight, numBlocks } = params.blockRangeRequest
        offset = NNG.GetBlockRangeRequest.createGetBlockRangeRequest(builder, startHeight, numBlocks)
        break
      case "GetBlockRequest":
        const { height } = params.blockRequest
        offset = NNG.GetBlockRequest.createGetBlockRequest(builder, NNG.BlockIdentifier.Height,
          NNG.BlockHeight.createBlockHeight(builder, height)
        )
        break
      // malformed call
      default:
        return
    }
    const rpcCall = NNG.RpcCall.createRpcCall(builder, NNG.RpcRequest[rpcType], offset)
    builder.finish(rpcCall)
    // Wrap the event listener and `rpc.send()` in a Promise to await response
    // Promise is resolved via `.once()` event after lotusd responds 
    // Then we can parse the blocks for RANK transactions
    const bb = <ByteBuffer> await new Promise((resolve, reject) => {
      const rpcSocketSendTimeout = setTimeout(
        () => reject(`rpcCall(): Socket.send() timeout reached (${NNG_REQUEST_TIMEOUT_LENGTH}ms)`),
        NNG_REQUEST_TIMEOUT_LENGTH
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
        // shut down if unhandled error
        default:
          this.close(
            ERR.NNG_RPC_REQUEST,
            `MAIN[rpcCall()]: ${result.errorMsg()} (code: ${result.errorCode()})`
          )
      }
    }
    return new ByteBuffer(result.dataArray())
  }
  /**
   * Fetch block at `height`
   * @param height Block height
   * @returns {Promise<NNG.Block>}
   */
  private async rpcGetBlock(height: number): Promise<NNG.Block> {
    const bb = await this.rpcCall('GetBlockRequest', { blockRequest: { height }})
    return bb?.bytes()?.length ? NNG.GetBlockResponse.getRootAsGetBlockResponse(bb).block() : null
  }
  /**
   * Fetches mempool txs
   * @returns {Promise<NNG.GetMempoolResponse>}
   */
  private async rpcGetMempool(): Promise<NNG.GetMempoolResponse> {
    const bb = await this.rpcCall('GetMempoolRequest')
    return NNG.GetMempoolResponse.getRootAsGetMempoolResponse(bb)
  }
  /**
   * Fetches range of blocks starting at `height`, up to `NNG_RPC_BLOCKRANGE_SIZE` limit
   * 
   * Configure `NNG_RPC_BLOCKRANGE_SIZE` in `/util/constants.ts` (default: 20)
   * @param height The starting height
   * @returns {Promise<NNG.GetBlockRangeResponse>}
   */
  private async rpcGetBlockRange(height: number): Promise<NNG.GetBlockRangeResponse> {
    const bb = await this.rpcCall('GetBlockRangeRequest', {
      blockRangeRequest: { startHeight: height, numBlocks: NNG_RPC_BLOCKRANGE_SIZE }
    })
    return NNG.GetBlockRangeResponse.getRootAsGetBlockRangeResponse(bb)
  }
  /**
   * 
   * @param data
   * @returns 
   */
  private processTransactions(data: NNG.Block | NNG.GetMempoolResponse) {
    const ranks: RankTransaction[] = []
    const txsLength = data.txsLength()
    // skip coinbase tx (i.e. `let j = 1`)
    for (let j = 1; j < txsLength; j++) {
      const txRaw = data.txs(j).tx().rawArray()
      // Convert Uint8Array to Buffer else bitcore parse will fail
      const tx = new Transaction(Buffer.from(txRaw))
      // Differentiate between Block or Mempool accordingly
      const block = data instanceof NNG.Block ? this.toBlock(data.header()) : null
      ranks.push(...this.processRawTransaction(tx, block)
      )
    }
    return ranks
  }
  /**
   * Parse the raw transaction for RANK outputs and return all `RankTransaction` objects
   * @param tx Transaction object in Bitcore format
   * @returns {RankTransaction[]} Array of `RankTransaction` objects
   */
  private processRawTransaction(
    tx: Transaction,
    block?: Block
  ): RankTransaction[] {
    const { txid, outputs } = tx
    // Use current time if tx from mempool
    const t = block?.timestamp ?? BigInt(Date.now())
    // block header timestamp in seconds; need milliseconds
    const ranks: RankTransaction[] = []
    for (let outIdx = 0; outIdx < outputs.length; outIdx++) {
      const output = outputs[outIdx]
      if (!this.isRankScript(output.script)) {
        continue
      }
      ranks.push({
        output: `${txid}_${outIdx}`,
        timestamp: t,
        height: block?.height ?? undefined,
        ...this.toRankOutput(output)
      })
    }
    return ranks
  }
  /**
   * Check if the provided `script` is a RANK script
   * @param script Bitcore-compatible `Script` object
   * @returns {false | Buffer}
   */
  private isRankScript(
    script: Script
  ): false | Buffer {
    // we only care about OP_RETURN outputs
    if (!script.isDataOut()) {
      return false
    }
    const scriptBuf = script.toBuffer()
    // prepare to parse lokad script parts
    const { lokad } = this.parts
    // make sure the script is long enough to parse for lokad
    if (scriptBuf.length < (lokad.offset + lokad.len)) {
      return false;
    }
    // make sure the script contains our lokad prefix
    if (this.getScriptPartHex(lokad, scriptBuf) !== lokad.hex) {
      return false;
    }
    // make sure the script contains all required parts
    // TODO: need to finish sanitizing
    const { sentiment, platform, profile, post, comment } = this.parts
    //this.getScriptParts(scriptBuf)

    // valid RANK output confirmed; return for processing
    return scriptBuf
  }
  /**
   * 
   * @param scriptBuf 
   */
  private getScriptParts(
    scriptBuf: Buffer
  ) {
    const parts: { [part: string]: BigInt | Boolean | string } = {}
    for (const [name, part] of Object.entries(this.parts)) {
      // TODO: Finish this one
    }
  }
  /**
   * Parse the provided `scriptBuf` for the ScriptPart hex data
   * @param part {ScriptPart} The ScriptPart for which to parse
   * @param scriptBuf {Buffer} The script buffer (`OP_RETURN` only)
   * @returns {string}
   */
  private getScriptPartHex(
    part: ScriptPart,
    scriptBuf: Buffer
  ): string {
    return scriptBuf
      .subarray(part.offset, (part.offset + part.len))
      .toString('hex')
  }
  /**
   * Convert raw tx output to RANK output 
   * @param output Transaction output in Bitcore-compatible format
   * @returns {RankOutput}
   */
  private toRankOutput(
    output: Transaction.Output
  ): RankOutput {
    const scriptBuf = output.script.toBuffer()
    const value = BigInt(output.satoshis)
    const sentiment = Boolean(Number(this.getScriptPartHex(this.parts.sentiment, scriptBuf)))
    const platform = this.getScriptPartHex(this.parts.platform, scriptBuf)
    const profileId = this.getScriptPartHex(this.parts.profile, scriptBuf)
    return { value, sentiment, platform, profileId }
  }
  /**
   * Parse the raw NNG 'Hash' flatbuffer for the 32-byte block hash
   * @param hash 
   * @returns {string} Block hash as hex string (little endian)
   */
  private toBlockhashOrTxid(hash: NNG.Hash): string {
    const hashBuf = Buffer.alloc(32)
    for (let i = 0; i < 32; i++) {
      const byte = hash.data(i)
      hashBuf.writeUInt8(byte, i)
    }
    // reverse for little endian
    // can probably remove this with proper buffer writing above
    return hashBuf.reverse().toString('hex')
  }
  /**
   * Parse the raw NNG `NNG.BlockHeader` flatbuffer for the nHeight
   * 
   * ref: https://docs.givelotus.org/specs/NNG.BlockHeader
   * @param header Raw `NNG.BlockHeader`
   * @returns {number} Block height as a number
   */
  private toHeight(header: NNG.BlockHeader): number {
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
  private toBlock(header: NNG.BlockHeader, prevhash: boolean = false): Block {
    return {
      height: this.toHeight(header),
      timestamp: header.timestamp(),
      hash: this.toBlockhashOrTxid(header.blockHash().hash()),
      prevhash: prevhash ? this.toBlockhashOrTxid(header.prevBlockHash().hash()): undefined,
      //ranks: [], // this will get filled later once txs are processed
      ranksLength: 0
    }
  }
  /**
   * 
   * @param ranks 
   * @returns 
   */
  private toProfiles(ranks: RankTransaction[]) {
    // Sort the RANK txs for upsert
    const profiles: Profile[] = []
    ranks.forEach((rank) => {
      const { profileId: id, platform } = rank
      const profile = profiles.find(({ id: pid }) => pid == id)
      // If we sorted this Profile already, push the RANK tx, otherwise push the Profile 
      profile?.ranks?.push(rank) ?? profiles.push({ id, platform, ranks: [rank] })
    })
    return profiles
  }
}
