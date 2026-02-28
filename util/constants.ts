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
/** R65: Minimum log-dampened total engagement for controversial feed inclusion.
 *  Filters posts with trivially small burns on both sides.
 *  At BASE=1_000_000 sats: log₂(1 + 100_000/1_000_000) ≈ 0.137 */
export const FEED_RANKING_CONTROVERSIAL_MIN_ENGAGEMENT = 0.1
/**
 * Feed ranking algorithm constants (R62–R66)
 * Implements burn-only, Sybil-neutral dampening for the off-chain feed layer.
 * All functions operate on aggregate burn totals — never per-voter amounts.
 * The user-facing name for this sort mode is 'curated'.
 */
/** R62: Logarithmic dampening base in satoshis. Burns at this level = 1.0 feed weight unit. */
export const FEED_RANKING_LOG_BASE_SATS = 1_000_000n // 1 XPI = 1.0 unit
/** R63: Maximum z-score for feed display. Caps outliers to prevent feed monopoly. */
export const FEED_RANKING_ZSCORE_MAX = 3.0
/** R63: Minimum number of scored posts before z-score normalization activates. */
export const FEED_RANKING_ZSCORE_MIN_POSTS = 10
/** R64: Half-life for temporal conviction decay, in hours. */
export const FEED_RANKING_HALFLIFE_HOURS = 72
/** R65: Controversy threshold (0–1). Above this ratio, a post is flagged as controversial. */
export const FEED_RANKING_CONTROVERSY_THRESHOLD = 0.4
/** R66: Velocity window for spike detection, in hours. */
export const FEED_RANKING_VELOCITY_WINDOW_HOURS = 6
/** R66: Velocity ratio above which sigmoid dampening begins. */
export const FEED_RANKING_VELOCITY_THRESHOLD = 10.0
/** R66: Sigmoid steepness parameter for velocity dampening curve. */
export const FEED_RANKING_VELOCITY_SIGMOID_K = 0.5
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
