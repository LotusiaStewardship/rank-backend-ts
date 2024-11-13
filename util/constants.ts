import type {
  ScriptChunkLokadMap,
  ScriptChunkPlatformMap,
  ScriptChunkSentimentMap,
  ScriptChunkLokadUTF8,
  ScriptChunkPlatformUTF8,
  ScriptChunkSentimentUTF8,
  PlatformParameters,
  Block,
} from './types'
/**
 * NNG configuration
 */
export const NNG_PUB_DEFAULT_SOCKET_PATH = '~/.lotus/pub.pipe'
export const NNG_RPC_DEFAULT_SOCKET_PATH = '~/.lotus/rpc.pipe'
export const NNG_RPC_RCVMAXSIZE_CONSENSUS = 2097152
export const NNG_RPC_BLOCKRANGE_SIZE = 20
export const NNG_SOCKET_RECONN = 300 // time (ms) between reconnect attempts
export const NNG_SOCKET_MAXRECONN = 3000 // max time (ms) before giving up reconnect
export const NNG_REQUEST_TIMEOUT_LENGTH = 2000 // max time (ms) before aborting a Socket.send()
/**
 * RANK script configuration
 */
export const RANK_SCRIPT_MIN_BYTE_LENGTH = 26 // required byte length for valid RANK tx
/** First block with a RANK transaction */
export const RANK_BLOCK_GENESIS_V1: Partial<Block> = {
  hash: '00000000019cc1ddc04bc541f531f1424d04d0c37443867f1f6137cc7f7d09e5',
  height: 811624,
}
/**
 * RANK script types and constants
 */
export const SCRIPT_CHUNK_LOKAD: ScriptChunkLokadMap = new Map()
SCRIPT_CHUNK_LOKAD.set(0x52414e4b, 'RANK')
export const SCRIPT_CHUNK_PLATFORM: ScriptChunkPlatformMap = new Map()
SCRIPT_CHUNK_PLATFORM.set(0x00, 'WEB_URL') // any URL; the PROFILE script chunk is not necessary
SCRIPT_CHUNK_PLATFORM.set(0x01, 'TWITTER') // twitter.com/x.com
export const SCRIPT_CHUNK_SENTIMENT: ScriptChunkSentimentMap = new Map()
SCRIPT_CHUNK_SENTIMENT.set(0x51, 'POSITIVE') // OP_1 | OP_TRUE
SCRIPT_CHUNK_SENTIMENT.set(0x00, 'NEGATIVE') // OP_0 | OP_FALSE
export const RANK_SCRIPT_CHUNKS = {
  LOKAD: SCRIPT_CHUNK_LOKAD,
  PLATFORM: SCRIPT_CHUNK_PLATFORM,
  SENTIMENT: SCRIPT_CHUNK_SENTIMENT,
  PROFILE: null,
  POST: null,
  COMMENT: null,
}
/**
 * Platform stuff
 */
export const PLATFORMS: {
  [name in ScriptChunkPlatformUTF8]: Partial<PlatformParameters>
} = {
  WEB_URL: {},
  TWITTER: {
    profileMaxLength: 16,
  },
}
/**
 * Error codes
 */
export enum ERR {
  NNG_CONNECT = 1,
  NNG_PROCESS_MESSAGE,
  IDX_PROFILE_REWIND,
  IDX_BLOCKS_REWIND,
  IDX_BLOCKS_SYNC,
  IDX_MEMPOOL_SYNC,
  UNHANDLED_EXCEPTION = 255,
}
