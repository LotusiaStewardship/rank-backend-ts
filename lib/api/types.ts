import { Request, Response, NextFunction } from 'express'
import { ScriptChunkPlatformUTF8 } from 'xpi-ts/lib/rank'

/**
 * Represents a profile's ranking information including total and change metrics
 */
export type RankTopProfile = {
  /** Overall ranking statistics */
  total: {
    /** The total ranking score */
    ranking: string
    /** Total number of positive votes received */
    votesPositive: number
    /** Total number of negative votes received */
    votesNegative: number
  }
  /** Metrics showing ranking changes */
  changed: {
    /** The change in ranking score */
    ranking: string
    /** The rate of change */
    rate: string
    /** Number of new positive votes */
    votesPositive: number
    /** Number of new negative votes */
    votesNegative: number
  }
  /** Array of votes within the timespan, or null if not available */
  votesTimespan: string[] | null
  /** Unique identifier for the profile */
  profileId: string
  /** The social media platform */
  platform: ScriptChunkPlatformUTF8
}

/**
 * Represents a post's ranking information, extending RankTopProfile with an optional postId
 */
export type RankTopPost = RankTopProfile & {
  postId?: string
}

/** Available API endpoint names for routing */
export type Endpoint =
  | 'profiles'
  | 'profile'
  | 'post'
  | 'posts'
  | 'profilePosts'
  | 'stats'
  | 'instance'
  | 'wallet'
  | 'feed'
  | 'trending'
  | 'charts'
  | 'search'
  | 'tx'
  | 'txs'
  | 'voteActivity'
  | 'feedPosts'
  | 'feedTrending'
  | 'leaderboard'
  | 'referralGenerate'
  | 'referralRedeem'
  | 'referralGenesis'
  | 'engagement'

/** Handler function type for processing API endpoint requests */
export type EndpointHandler = (
  req: Request,
  res: Response,
  next: NextFunction,
) => void

/** Available parameter names that can be validated in API endpoints */
export type EndpointParameter =
  | 'platform'
  | 'profileId'
  | 'postId'
  | 'scriptPayload'
  | 'statsRoute'
  | 'pageNum'
  | 'pageSize'
  | 'instanceId'
  | 'chartType'
  | 'dataType'
  | 'searchType'
  | 'txid'

/** Handler function type for validating and processing endpoint parameters */
export type EndpointParameterHandler = (
  req: Request,
  res: Response,
  next: NextFunction,
  param: string | ScriptChunkPlatformUTF8 | ChartType,
) => void

/** This type is data returned from the database, not Temporal */
export type ChartWalletSummary = {
  /** Total number of votes cast */
  totalVotes: number
  /** Total number of upvotes cast */
  totalUpvotes: number
  /** Total number of downvotes cast */
  totalDownvotes: number
  /** Total number of unique wallets that voted */
  totalUniqueWallets: number
  /** Total amount of Lotus burned in all of the votes */
  totalSatsBurned: number
}

/** This type is data returned from the Temporal workflow */
export type WalletRankActivityWorkflowResult = {
  /** Total number of votes cast */
  totalVotes: number
  /** Total number of payouts sent */
  totalPayoutsSent: number
  /** Total amount of sats sent */
  totalPayoutAmount: number
}

/** Available chart types for data visualization endpoints */
export type ChartType = 'wallet'

/** Types of chart data that can be requested */
export type ChartDataType = 'summary' | 'activity'

/** Mapping of stats route paths to their corresponding database method names */
export const StatsRoutes = {
  'profiles/top-ranked': 'getStatsPlatformRanked',
  'profiles/lowest-ranked': 'getStatsPlatformRanked',
  'posts/top-ranked': 'getStatsPlatformRanked',
  'posts/lowest-ranked': 'getStatsPlatformRanked',
} as const

/** Valid stats route path strings */
export type StatsRoute = keyof typeof StatsRoutes

/** Authentication header parameters provided to client for authorization to API */
export const AuthenticateHeader = {
  /** The scheme of the authentication header */
  scheme: 'BlockDataSig' as const,
  /** The parameters of the authentication header */
  param: ['blockhash', 'blockheight'] as const,
}
