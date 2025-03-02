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
export const NNG_RPC_RCVMAXSIZE_CONSENSUS = 2_097_152 // 2 MiB (2^20 * 2)
export const NNG_RPC_BLOCKRANGE_SIZE = 20
export const NNG_SOCKET_RECONN = 300 // time (ms) between reconnect attempts
export const NNG_SOCKET_MAXRECONN = 3_000 // max time (ms) before giving up reconnect
export const NNG_REQUEST_TIMEOUT_LENGTH = 2_000 // max time (ms) before aborting a Socket.send()
/**
 * Error codes
 */
export enum ERR {
  NNG_CONNECT = 1,
  NNG_PROCESS_MESSAGE,
  IDX_DATABASE_CONNECT,
  IDX_PROFILE_REWIND,
  IDX_BLOCKS_REWIND,
  IDX_BLOCKS_SYNC,
  IDX_MEMPOOL_SYNC,
  UNHANDLED_EXCEPTION = 255,
}
