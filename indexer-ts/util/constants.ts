/**
 * NNG configuration
 */
export const NNG_RPC_URL = 'ipc:///home/matthew/.lotus/rpc.pipe'
//export const NNG_RPC_URL = 'tcp://172.16.2.20:10634'
export const NNG_PUB_URL = 'ipc:///home/matthew/.lotus/pub.pipe'
//export const NNG_PUB_URL = 'tcp://172.16.2.20:10633'
export const NNG_RPC_RCVMAXSIZE_CONSENSUS = 2097152
export const NNG_RPC_BLOCKRANGE_SIZE = 20
export const NNG_SOCKET_RECONN = 300 // time (ms) between reconnect attempts
export const NNG_SOCKET_MAXRECONN = 3000 // max time (ms) before giving up reconnect
export const NNG_REQUEST_TIMEOUT_LENGTH = 2000 // max time (ms) before aborting a Socket.send()
/**
 * Twitter stuff
 */
export const TWITTER_PROFILE_LENGTH = 16 // maximum length of profile handle
/**
 * Error codes
 */
export enum ERR {
  NNG_CONNECT = 1,
  NNG_DISCONNECT = 2,
  NNG_RPC_REQUEST = 3,
  NNG_MEMPOOLTXADD = 4,
  NNG_BLKCONNCETED = 5,
  NNG_BLKDISCONCTD = 6,
  NNG_PROCESS_MESSAGE = 7,
  IDX_BLOCKS_SYNC= 11,
  IDX_MEMPOOL_SYNC = 12,
  IDX_PROFILE_REWIND = 13,
  IDX_BLOCKS_REWIND = 14,
  IDX_PROFILE_UPSERT = 15,
  DB_UPSERT = 23,
  UNHANDLED_EXCEPTION = 69,
}