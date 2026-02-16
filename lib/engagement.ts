import type { Database } from './database'

/**
 * Engagement Points (EP) weight configuration.
 * EP = (votes × W_VOTES) + (redeemedReferrals × W_REFERRALS)
 *    + (refereeAt10Votes × W_REFEREE_10) + (refereeAt50Votes × W_REFEREE_50)
 *    + (rnkcComments × W_COMMENTS) + (√(totalXpiBurned/100) × W_BURN)
 *    + (streakDays × W_STREAK) + (min(accountAgeMonths, 12) × W_AGE)
 */
export const EP_WEIGHTS = {
  votes: 1,
  referrals: 10,
  referee10Votes: 5,
  referee50Votes: 10,
  comments: 3,
  burn: 1,
  streak: 0.5,
  age: 2,
  ageCapMonths: 12,
} as const

/**
 * Tier thresholds and bonus multipliers.
 * Tiers are assigned based on cumulative EP score.
 *
 * | Tier | Name      | EP Required | Bonus |
 * |------|-----------|------------|-------|
 * | 0    | Newcomer  | 0-19       | +0    |
 * | 1    | Voter     | 20-99      | +0.5  |
 * | 2    | Regular   | 100-499    | +1    |
 * | 3    | Advocate  | 500-1999   | +1.5  |
 * | 4    | Champion  | 2000-9999  | +2    |
 * | 5    | Steward   | 10000+     | +3    |
 */
export const TIER_THRESHOLDS = [
  { tier: 0, name: 'Newcomer', minEP: 0, bonus: 0 },
  { tier: 1, name: 'Voter', minEP: 20, bonus: 0.5 },
  { tier: 2, name: 'Regular', minEP: 100, bonus: 1 },
  { tier: 3, name: 'Advocate', minEP: 500, bonus: 1.5 },
  { tier: 4, name: 'Champion', minEP: 2_000, bonus: 2 },
  { tier: 5, name: 'Steward', minEP: 10_000, bonus: 3 },
] as const

/**
 * Streak bonus multiplier thresholds.
 * Applied on top of the base payout multiplier.
 */
export const STREAK_BONUS_THRESHOLDS = [
  { minDays: 0, bonus: 0 },
  { minDays: 3, bonus: 0.25 },
  { minDays: 7, bonus: 0.5 },
  { minDays: 14, bonus: 1.0 },
  { minDays: 30, bonus: 1.5 },
  { minDays: 60, bonus: 2.0 },
] as const

/**
 * Referrer bonus: awarded when a referee reaches vote milestones.
 * The referrer gets this bonus added to their payout multiplier.
 */
export const REFERRER_BONUS = 1.0

/**
 * EP breakdown structure returned by computeEPBreakdown
 */
export type EPBreakdown = {
  votes: number
  referrals: number
  comments: number
  burn: number
  streak: number
  age: number
  total: number
}

/**
 * Computes the composite Engagement Points (EP) score from raw metrics.
 *
 * @param votes - Lifetime vote count
 * @param referrals - Number of redeemed referrals by this user
 * @param comments - Number of RNKC comments posted
 * @param totalBurnedSats - Total XPI burned (in satoshis) across all RANK txs
 * @param streakDays - Current consecutive voting streak in days
 * @param accountAgeMonths - Account age in months (capped at 12)
 * @returns The total EP score
 */
export function computeEngagementPoints(
  votes: number,
  referrals: number,
  comments: number,
  totalBurnedSats: bigint,
  streakDays: number,
  accountAgeMonths: number,
): number {
  const breakdown = computeEPBreakdown(
    votes,
    referrals,
    comments,
    totalBurnedSats,
    streakDays,
    accountAgeMonths,
  )
  return breakdown.total
}

/**
 * Computes the full EP breakdown with per-category scores.
 *
 * @param votes - Lifetime vote count
 * @param referrals - Number of redeemed referrals by this user
 * @param comments - Number of RNKC comments posted
 * @param totalBurnedSats - Total XPI burned (in satoshis) across all RANK txs
 * @param streakDays - Current consecutive voting streak in days
 * @param accountAgeMonths - Account age in months (capped at 12)
 * @returns The EP breakdown with per-category and total scores
 */
export function computeEPBreakdown(
  votes: number,
  referrals: number,
  comments: number,
  totalBurnedSats: bigint,
  streakDays: number,
  accountAgeMonths: number,
): EPBreakdown {
  const votesEP = votes * EP_WEIGHTS.votes
  const referralsEP = referrals * EP_WEIGHTS.referrals
  const commentsEP = comments * EP_WEIGHTS.comments
  // Sub-linear √ scaling on burn amount to prevent whale dominance
  // Convert sats to XPI (1 XPI = 1_000_000 sats), then divide by 100 for scaling
  const burnXPI = Number(totalBurnedSats) / 1_000_000
  const burnEP = Math.sqrt(burnXPI / 100) * EP_WEIGHTS.burn
  const streakEP = streakDays * EP_WEIGHTS.streak
  const cappedAge = Math.min(accountAgeMonths, EP_WEIGHTS.ageCapMonths)
  const ageEP = cappedAge * EP_WEIGHTS.age

  const total = votesEP + referralsEP + commentsEP + burnEP + streakEP + ageEP

  return {
    votes: Math.round(votesEP * 100) / 100,
    referrals: Math.round(referralsEP * 100) / 100,
    comments: Math.round(commentsEP * 100) / 100,
    burn: Math.round(burnEP * 100) / 100,
    streak: Math.round(streakEP * 100) / 100,
    age: Math.round(ageEP * 100) / 100,
    total: Math.round(total * 100) / 100,
  }
}

/**
 * Determines the tier for a given EP score.
 *
 * @param ep - The engagement points score
 * @returns The tier number (0-5)
 */
export function computeTierFromEP(ep: number): number {
  for (let i = TIER_THRESHOLDS.length - 1; i >= 0; i--) {
    if (ep >= TIER_THRESHOLDS[i].minEP) {
      return TIER_THRESHOLDS[i].tier
    }
  }
  return 0
}

/**
 * Gets the tier bonus multiplier for a given tier.
 *
 * @param tier - The tier number (0-5)
 * @returns The bonus multiplier for the tier
 */
export function getTierBonus(tier: number): number {
  const entry = TIER_THRESHOLDS.find(t => t.tier === tier)
  return entry?.bonus ?? 0
}

/**
 * Gets the tier name for a given tier number.
 *
 * @param tier - The tier number (0-5)
 * @returns The human-readable tier name
 */
export function getTierName(tier: number): string {
  const entry = TIER_THRESHOLDS.find(t => t.tier === tier)
  return entry?.name ?? 'Unknown'
}

/**
 * Computes the streak bonus multiplier based on consecutive voting days.
 *
 * @param streakDays - The current consecutive voting streak in days
 * @returns The streak bonus multiplier
 */
export function computeStreakBonus(streakDays: number): number {
  for (let i = STREAK_BONUS_THRESHOLDS.length - 1; i >= 0; i--) {
    if (streakDays >= STREAK_BONUS_THRESHOLDS[i].minDays) {
      return STREAK_BONUS_THRESHOLDS[i].bonus
    }
  }
  return 0
}

/**
 * Computes the current streak length from an array of distinct vote dates (descending order).
 * A streak is broken if there is a gap of more than 1 day between consecutive vote dates.
 *
 * @param voteDates - Array of date strings (YYYY-MM-DD) in descending order
 * @returns The current streak length in days
 */
export function computeStreakFromDates(voteDates: string[]): number {
  if (voteDates.length === 0) return 0

  const today = new Date()
  today.setUTCHours(0, 0, 0, 0)
  const todayMs = today.getTime()

  const firstDate = new Date(voteDates[0])
  firstDate.setUTCHours(0, 0, 0, 0)
  const firstDateMs = firstDate.getTime()

  // If the most recent vote is not today or yesterday, streak is broken
  const daysSinceLastVote = Math.floor(
    (todayMs - firstDateMs) / 86_400_000,
  )
  if (daysSinceLastVote > 1) return 0

  let streak = 1
  for (let i = 1; i < voteDates.length; i++) {
    const current = new Date(voteDates[i - 1])
    const previous = new Date(voteDates[i])
    current.setUTCHours(0, 0, 0, 0)
    previous.setUTCHours(0, 0, 0, 0)
    const diffDays = Math.floor(
      (current.getTime() - previous.getTime()) / 86_400_000,
    )
    if (diffDays === 1) {
      streak++
    } else {
      break
    }
  }
  return streak
}

/**
 * Computes the account age in months from the earliest RANK transaction timestamp.
 *
 * @param earliestTimestamp - The earliest RANK tx timestamp (unix seconds as bigint), or null
 * @returns The account age in whole months
 */
export function computeAccountAgeMonths(
  earliestTimestamp: bigint | null,
): number {
  if (earliestTimestamp === null) return 0
  const now = new Date()
  const earliest = new Date(Number(earliestTimestamp) * 1_000)
  const diffMs = now.getTime() - earliest.getTime()
  // Approximate months as 30.44 days
  return Math.floor(diffMs / (30.44 * 86_400_000))
}

/**
 * Computes the full engagement profile for a wallet by gathering all metrics
 * from the database and computing EP, tier, streak, and breakdown.
 *
 * @param db - The Database instance
 * @param scriptPayload - The wallet's scriptPayload
 * @returns Object with all computed engagement data ready for upsert
 */
export async function computeFullEngagement(
  db: Database,
  scriptPayload: string,
): Promise<{
  tier: number
  engagementPoints: number
  epBreakdown: EPBreakdown
  lifetimeVotes: number
  lifetimeReferrals: number
  lifetimeComments: number
  currentStreak: number
  longestStreak: number
  lastVoteDate: Date | null
}> {
  // Gather all raw metrics in parallel
  const [
    lifetimeVotes,
    lifetimeReferrals,
    lifetimeComments,
    totalBurnedSats,
    earliestTimestamp,
    latestTimestamp,
    voteDates,
    existingEngagement,
  ] = await Promise.all([
    db.countRankTxsByScriptPayload(scriptPayload),
    db.countRedeemedReferralsByReferrer(scriptPayload),
    db.countRnkcCommentsByScriptPayload(scriptPayload),
    db.getTotalBurnedByScriptPayload(scriptPayload),
    db.getEarliestRankTimestamp(scriptPayload),
    db.getLatestRankTimestamp(scriptPayload),
    db.getDistinctVoteDates(scriptPayload),
    db.getOrCreateWalletEngagement(scriptPayload),
  ])

  // Compute streak
  const currentStreak = computeStreakFromDates(voteDates)
  const longestStreak = Math.max(
    currentStreak,
    existingEngagement.longestStreak,
  )

  // Compute account age
  const accountAgeMonths = computeAccountAgeMonths(earliestTimestamp)

  // Compute EP
  const epBreakdown = computeEPBreakdown(
    lifetimeVotes,
    lifetimeReferrals,
    lifetimeComments,
    totalBurnedSats,
    currentStreak,
    accountAgeMonths,
  )

  // Compute tier
  const tier = computeTierFromEP(epBreakdown.total)

  // Compute last vote date
  const lastVoteDate = latestTimestamp
    ? new Date(Number(latestTimestamp) * 1_000)
    : null

  return {
    tier,
    engagementPoints: epBreakdown.total,
    epBreakdown,
    lifetimeVotes,
    lifetimeReferrals,
    lifetimeComments,
    currentStreak,
    longestStreak,
    lastVoteDate,
  }
}
