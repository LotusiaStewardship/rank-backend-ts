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
 * RANK script declarations
 */
export enum SCRIPT_PART_LOKAD {
  RANK = '52414e4b' // "RANK"
}
export enum SCRIPT_PART_PLATFORM {
  TWITTER = '01'
}
export enum SCRIPT_PART_SENTIMENT {
  POSITIVE = '51', // OP_1 | OP_TRUE
  NEGATIVE = '00', // OP_0 | OP_FALSE
}
export const RANK_SCRIPT_MIN_BYTE_LENGTH = 26 // required byte length for valid RANK tx
export const RANK_SCRIPT_PARTS = {
  LOKAD: SCRIPT_PART_LOKAD,
  PLATFORM: SCRIPT_PART_PLATFORM,
  SENTIMENT: SCRIPT_PART_SENTIMENT,
  PROFILE: null,
  POST: null,
  COMMENT: null,
}
/**
 * Twitter stuff
 */
export const TWITTER_PROFILE_LENGTH = 16 // maximum length of profile handle
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
