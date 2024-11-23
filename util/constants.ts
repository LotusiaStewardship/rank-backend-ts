import type {
  ScriptChunk,
  ScriptChunkLokadMap,
  ScriptChunkPlatformMap,
  ScriptChunkSentimentMap,
  ScriptChunkPlatformUTF8,
  PlatformParameters,
  Block,
  ScriptChunkField,
} from './types'
/**
 * API configuration
 */
export const API_SERVER_PORT = 10655
export const API_STATS_RESULT_COUNT = 5
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
export const RANK_OUTPUT_MIN_VALUE = 1_000_000 // minimum burn value in sats
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
//SCRIPT_CHUNK_PLATFORM.set(0x00, 'web_url') // any URL; the PROFILE script chunk is not necessary
SCRIPT_CHUNK_PLATFORM.set(0x01, 'twitter') // twitter.com/x.com
export const SCRIPT_CHUNK_SENTIMENT: ScriptChunkSentimentMap = new Map()
SCRIPT_CHUNK_SENTIMENT.set(0x51, 'positive') // OP_1 | OP_TRUE
SCRIPT_CHUNK_SENTIMENT.set(0x00, 'negative') // OP_0 | OP_FALSE
export const RANK_SCRIPT_CHUNKS: {
  [name in ScriptChunkField]: ScriptChunk
} = {
  lokad: {
    len: 4,
    map: SCRIPT_CHUNK_LOKAD,
  },
  sentiment: {
    len: 1,
    map: SCRIPT_CHUNK_SENTIMENT,
  },
  platform: {
    len: 1,
    map: SCRIPT_CHUNK_PLATFORM,
  },
  profile: {
    len: null,
  },
  post: {
    len: null,
  },
  comment: {
    len: null,
  },
}
/**
 * Platform stuff
 */
export const PLATFORMS: {
  [name in ScriptChunkPlatformUTF8]: PlatformParameters
} = {
  twitter: {
    profileId: {
      len: 16,
    },
    postId: {
      chunkLength: 8, // 64-bit uint: https://developer.x.com/en/docs/x-ids
      regex: /[0-9]+/,
      reader: 'readBigUInt64BE',
      type: 'BigInt',
    },
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
