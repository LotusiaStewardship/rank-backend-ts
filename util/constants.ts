import type { Block } from 'lotus-nng-client'
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
export const API_WALLET_RESULT_COUNT = 10
export const API_SEARCH_RESULT_COUNT = 5
export const API_AUTH_CACHE_ENTRY_TTL = 420 // blocks over 1 day time span
/**
 * Feed configuration
 */
export const API_FEED_DEFAULT_PAGE_SIZE = 20
export const API_FEED_MAX_PAGE_SIZE = 100
export const API_FEED_CACHE_TTL_SECONDS = 60 // 1 minute cache for feed queries
export const API_FEED_TRENDING_WINDOW_HOURS = 24 // Trending content from last 24h
export const API_FEED_CONTROVERSIAL_MIN_VOTES = 5 // Minimum votes for controversy calculation
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
 * RANK configuration
 */
/** First block with a RANK transaction */
// 12/4/25: This is no longer used; height/hash are pulled from .env
// e.g.
// RANK_GENESIS_HEIGHT=952169
// RANK_GENESIS_HASH=0000000000c974cb635064bec0db8cc64a75526871f581ea5dbeca7a98551546
export const RANK_BLOCK_GENESIS_V1: Partial<Block> = {
  hash: '0000000000c974cb635064bec0db8cc64a75526871f581ea5dbeca7a98551546',
  height: 952169,
}
/**
 * Referral system
 */
export const REFERRAL_CODE_LENGTH = 16
export const REFERRAL_CODE_EXPIRY_HOURS = 72
export const REFERRAL_GENESIS_EXPIRY_HOURS = 168 // 7 days
export const REFERRAL_MAX_OUTSTANDING = 3
export const REFERRAL_MIN_VOTES = 1
export const REFERRAL_MIN_ACCOUNT_AGE = 100 // blocks (~2.8 hours)
export const REFERRAL_REDEEM_IP_LIMIT = 3 // per 24h
export const REFERRAL_GENESIS_REFERRER = 'stewardship'
/**
 * Faucet drip milestones
 */
export const FAUCET_DRIP_MILESTONE_1 = 200_000000n // 200 XPI (on redemption)
export const FAUCET_DRIP_MILESTONE_2 = 200_000000n // 200 XPI (1st vote)
export const FAUCET_DRIP_MILESTONE_3 = 300_000000n // 300 XPI (5th vote)
export const FAUCET_DRIP_MILESTONE_4 = 300_000000n // 300 XPI (10th vote)
export const FAUCET_MILESTONE_VOTES = [0, 1, 5, 10]
export const FAUCET_DRIP_AMOUNTS = [
  FAUCET_DRIP_MILESTONE_1,
  FAUCET_DRIP_MILESTONE_2,
  FAUCET_DRIP_MILESTONE_3,
  FAUCET_DRIP_MILESTONE_4,
]
/**
 * HTTP status codes
 */
export enum HTTP {
  /** Success */
  OK = 200,
  CREATED = 201,
  ACCEPTED = 202,
  /** Redirection */
  MOVED_PERMANENTLY = 301,
  /** Client errors */
  BAD_REQUEST = 400,
  UNAUTHORIZED = 401,
  PAYMENT_REQUIRED = 402,
  FORBIDDEN = 403,
  NOT_FOUND = 404,
  CONFLICT = 409,
  GONE = 410,
  TOO_MANY_REQUESTS = 429,
  /** Server errors */
  INTERNAL_SERVER_ERROR = 500,
  NOT_IMPLEMENTED = 501,
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
