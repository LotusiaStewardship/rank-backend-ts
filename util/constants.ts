import os from 'node:os'
/**
 * Extension configuration
 */
export const EXT_INSTANCE_ID_DIFFICULTY = 4
/**
 * API configuration
 */
export const API_SERVER_PORT = 10655
export const API_STATS_RESULT_COUNT = 5
export const API_SEARCH_RESULT_COUNT = 5
export const API_AUTH_CACHE_ENTRY_TTL = 420 // blocks over 1 day time span
/**
 * NNG configuration
 */
export const NNG_PUB_DEFAULT_SOCKET_PATH = `${os.homedir()}/.lotus/pub.pipe`
export const NNG_RPC_DEFAULT_SOCKET_PATH = `${os.homedir()}/.lotus/rpc.pipe`
export const NNG_RPC_RCVMAXSIZE_POLICY = 33_554_432 // 32 MiB (2^20 * 32)
export const NNG_RPC_BLOCKRANGE_SIZE = 20
export const NNG_SOCKET_RECONN = 300 // time (ms) between reconnect attempts
export const NNG_SOCKET_MAXRECONN = 3_000 // max time (ms) before giving up reconnect
export const NNG_REQUEST_TIMEOUT_LENGTH = 2_000 // max time (ms) before aborting a Socket.send()
export const NNG_MESSAGE_BATCH_SIZE = 10 // number of messages to process in each batch
/**
 * HTTP status codes
 */
export enum HTTP {
  /** Success */
  OK = 200,
  ACCEPTED = 202,
  /** Redirection */
  MOVED_PERMANENTLY = 301,
  /** Client errors */
  BAD_REQUEST = 400,
  UNAUTHORIZED = 401,
  PAYMENT_REQUIRED = 402,
  FORBIDDEN = 403,
  NOT_FOUND = 404,
}
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
