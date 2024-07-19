import {
  Script,
  Transaction
} from '@abcpros/bitcore-lib-xpi'
import { ByteBuffer } from 'flatbuffers'
import {
  BlockConnected,
  BlockDisconnected,
  BlockHeader,
  Hash,
  TransactionAddedToMempool,
  TransactionRemovedFromMempool,
} from './nng-interface'
import { Socket, socket } from 'nanomsg'
import {
  ChronikClient,
  Tx,
  TxOutput
} from 'chronik-client'
import { Database } from './database'
import {
  GENESIS_BLOCK_HASH,
  GENESIS_BLOCK_HEIGHT
} from '../util/constants'

export type Checkpoint = {
  height: number,
  hash: string
}

export type ScriptPart = {
  offset: number,
  len: number,
  hex?: string,
}

// Common type merging Chronik and Bitcore transaction types
export type ParsedTransaction = {
  txid: string,
  timestamp: Date // unix
  outputs: Transaction.Output[]
}

export type NNGMessageType = 
  'mempooltxadd' |
  'mempooltxrem' |
  'blkconnected' |
  'blkdisconctd'

// LOKAD prefix "RANK" (0x52414e4b)
// OP_RETURN <RANK> <sentiment> <profileId>
type RankOutput = {
  platform: string // e.g. Twitter/X.com
  profileId: string // who the ranking is for
  sentiment: boolean // true = positive, false = negative
  value: string // sats for sentiment
}

export type RankTransaction = RankOutput & {
  output: string // formatted <txid>_<outIdx>
  timestamp: Date // unix timestamp
}

export type Profile = {
  id: string // 16-byte hexadecimal representation of profile name (e.g. mcp011011)
  platform: string // e.g. Twitter
}

export class Node {
  private db: Database
  private client: ChronikClient
  private nng: Socket
  private nngUri: string
  private parts: {
    [part in 'lokad' | 'sentiment' | 'platform' | 'profile']: ScriptPart
  } = {
    lokad: { offset: 2, len: 4, hex: Buffer.from('RANK').toString('hex') },
    sentiment: { offset: 6, len: 1 },
    platform: { offset: 8, len: 1 },
    profile: { offset: 10, len: 16 }
  }
  private genesis: Checkpoint = {
    height: GENESIS_BLOCK_HEIGHT,
    hash: GENESIS_BLOCK_HASH
  }

  constructor(
    chronikUri: string,
    nngUri: string,
    chan: Array<NNGMessageType>
  ) {
    this.db = new Database()
    this.client = new ChronikClient(chronikUri)
    this.nngUri = nngUri
    this.nng = socket('sub', { chan })
    this.nng.on('data', this.nngMessageHandler)
  }

  async init() {
    // signal handlers
    process.on('SIGINT', this.close)
    process.on('SIGTERM', this.close)
    // connect db
    await this.db.connect()
    // sync from existing start height first
    const start = await this.db.getCheckpoint() || this.genesis
    const checkpoint = await this.sync(start.height)
    // save new checkpoint height
    await this.db.saveCheckpoint(checkpoint)
    // ready for NNG
    await this.connect()
    console.log('database synced and NNG connected')
  }
  /**
   * Sync blocks from the `startHeight` and save any new RANK transactions
   * to the database.
   */
  private async sync(startHeight: number): Promise<Checkpoint> {
    try {
      // Get the blockchain tip height
      let { tipHeight, tipHash } = await this.client.blockchainInfo()
      // Start processing new blocks
      for (startHeight; startHeight < tipHeight; startHeight++) {
        // Array of RANK txes we will eventually dump to the database
        const ranks: RankTransaction[] = []
        try {
          // Get the block and update the current tipHash for checkpoint update
          const block = await this.client.block(startHeight)
          tipHash = block.blockInfo.hash
          // process each tx in the block
          for (const tx of block.txs) {
            ranks.push(...this.processRawTransaction(tx))
          }
          // ensure ranked profiles are added to the database
          // this satisfies the FOREIGN KEY 
          for (const rank of ranks) {
            const result = await this.db.isExistingProfile(rank.profileId)
            if (!result) {
              await this.db.createAccount({
                id: rank.profileId,
                platform: rank.platform
              })
            }
          }
          // save the RANK txs from the block into database
          const insertCount = await this.db.saveRankTransactions(ranks)
          console.log(`height ${startHeight} - ${insertCount} saved to db`)
        } catch (e: any) {
          throw new Error(`sync: ${startHeight}: ${e.message}`)
        }
      }
      // return current height to update state
      return { height: startHeight, hash: tipHash }
    } catch (e: any) {
      throw new Error(`sync: ${e.message}`)
    }
  }

  /**
   * Establish connection to NNG socket via provided URI
   * @returns {void}
   */
  async connect(): Promise<void> {
    const result = this.nng.connect(this.nngUri);
    if (!result) {
      this.close()
      throw new Error(`connect: Error connecting to NNG at ${this.nngUri}: ${result}`)
    }
  }
  /**
   * Shutdown established connections and close the NNG socket
   * @returns {void}
   */
  async close(): Promise<void> {
    console.log('process shutting down')
    // ignore shutdown() number since we're exiting anyway
    this.nng?.shutdown(this.nngUri)
    this.nng?.close()
    await this.db?.disconnect()
    process.exit(0)
  }

  private async nngMessageHandler(msg: Buffer): Promise<void> {
    const msgType = msg.subarray(0, 12).toString() as NNGMessageType
    const bb = new ByteBuffer(msg.subarray(12))

    switch (msgType) {
      case 'mempooltxadd':
        try {
          // parse flatbuffer
          const mempooltx = TransactionAddedToMempool
            .getRootAsTransactionAddedToMempool(bb)
            .mempoolTx()
            .tx()
          // Transaction from raw buffer array
          const tx = new Transaction(Buffer.from(mempooltx.rawArray()))
          // get RANK outputs with tx references
          const ranks = this.processRawTransaction(tx)
          // save new ranks to db
          await this.db.saveRankTransactions(ranks)
          console.log(`${ranks.length} new rank transactions saved to db`)
        } catch (e: any) {
          throw new Error(`nngMessageHandler: mempooltxadd: ${e.message}`)
        }
        break
      case 'mempooltxrem':
        break
      case 'blkconnected':
        try {
          // parse flatbuffer
          const connectedBlock = BlockConnected.getRootAsBlockConnected(bb)
          // Get block and header
          const block = connectedBlock.block()
          const header = block.header()
          // Make sure the header actually has data to process
          if (!header.timestamp()) {
            return
          }
          // Get the block height from the 4-byte nHeight of the header
          const height = this.getBlockHeaderHeight(header)
          // Get the 32-byte block hash 
          const hash = this.getBlockHeaderHash(header.blockHash().hash())
          // TODO: remove disconnected mempool txs from database
          // TODO: update checkpoint height/hash
        } catch (e: any) {
          throw new Error(`nngMessageHandler: blkconnected: ${e.message}`)
        }
        break
    }
  }
  /**
   * Parse the raw transaction for RANK outputs and return all `RankTransaction` objects
   * @param tx Transaction object in Chronik or Bitcore format
   * @returns {RankTransaction[]} Array of `RankTransaction` objects
   */
  private processRawTransaction(
    tx: Tx | Transaction
  ): RankTransaction[] {
    const { txid, outputs, timestamp } = this.parseTransaction(tx)
    // Process the tx outputs and return all that are defined
    return outputs
      .map((output, outIdx) => {
        if (this.isRankScript(output.script)) {
          const outputString = `${txid}_${outIdx}`
          return { output: outputString, timestamp, ...this.parseOutput(output) }
        }
      })
      .filter(output => output !== undefined)
  }
  /**
   * Parse the required properties of the Chronik or Bitcore transaction, which
   * are then added to the `RankTransaction` objects prior to database insert
   * @param tx Chronik or Bitcore transaction
   * @returns {ParsedTransaction}
   */
  private parseTransaction(
    tx: Tx | Transaction
  ): ParsedTransaction {
    const txid = tx.txid
    // Chronik block time, or Chronik mempool time, or create time for NNG event
    const timestamp = (tx as Tx).block?.timestamp ?? (tx as Tx).timeFirstSeen ?? String(Date.now() / 1000)
    const date = new Date(Number(timestamp) * 1000)
    const outputs = tx instanceof Transaction
      ? tx.outputs
      : this.toTransactionOutputArray(tx.outputs)
    return { txid, outputs, timestamp: date }
  }
  /**
   * Process output from tx for RANK data
   * @param output Transaction output in Bitcore-compatible format
   * @returns {RankOutput}
   */
  private parseOutput(
    output: Transaction.Output
  ): RankOutput {
    const scriptBuf = output.script.toBuffer()
    const value = String(output.satoshis)
    const sentiment = Boolean(Number(this.getScriptPartHex(this.parts.sentiment, scriptBuf)))
    const platform = this.getScriptPartHex(this.parts.platform, scriptBuf)
    const profileId = this.getScriptPartHex(this.parts.profile, scriptBuf)
    return { value, sentiment, platform, profileId }
  }
  /**
   * Convert Chronik-style `TxOutput` format to Bitcore `Transaction.Output` format
   * @param outputs Chronik `TxOutput` array
   * @returns {Transaction.Output[]} Bitcore-compatible `Transaction.Output` array
   */
  private toTransactionOutputArray(
    outputs: TxOutput[]
  ): Transaction.Output[] {
    return outputs.map(output => {
      return new Transaction.Output({
        satoshis: Number(output.value),
        script: output.outputScript
      })
    })
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
    // Rank output confirmed; return for processing
    return scriptBuf
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
   * Parse the raw NNG `BlockHeader` flatbuffer for the block height
   * @param header Raw `BlockHeader`
   * @returns {number} Block height as a number
   */
  private getBlockHeaderHeight(header: BlockHeader) {
    const nHeight = header.rawArray().subarray(60, 64)
    return Buffer.from(nHeight).readUInt32LE()
  }
  /**
   * Parse the raw NNG 'Hash' flatbuffer for the 32-byte block hash
   * @param hash 
   * @returns 
   */
  private getBlockHeaderHash(hash: Hash) {
    const hashBuf = Buffer.alloc(32)
    for (let i = 0; i < 32; i++) {
      const byte = hash.data(i)
      hashBuf.writeUInt8(byte, i)
    }
    // reverse for little endian
    // can probably remove this with proper buffer writing above
    return hashBuf.reverse().toString('hex')
  }
}