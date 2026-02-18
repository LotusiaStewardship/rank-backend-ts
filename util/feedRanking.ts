/**
 * Feed ranking utility functions implementing burn-only, Sybil-neutral
 * dampening algorithms for the RANK off-chain feed layer (R62–R66).
 *
 * Design constraint: All functions operate exclusively on aggregate burn
 * totals (satsPositive, satsNegative) — never on per-voter amounts or
 * wallet counts. This ensures perfect Sybil neutrality: splitting the
 * same total burn across any number of wallets produces the same score.
 *
 * References:
 *   R62 — Aggregate Logarithmic Dampening
 *   R63 — Cross-Content Z-Score Capping
 *   R64 — Temporal Conviction Accumulation
 *   R65 — Bidirectional Signal Integration
 *   R66 — Burn Velocity Spike Dampening
 */

import {
  FEED_RANKING_LOG_BASE_SATS,
  FEED_RANKING_ZSCORE_MAX,
  FEED_RANKING_ZSCORE_MIN_POSTS,
  FEED_RANKING_HALFLIFE_HOURS,
  FEED_RANKING_CONTROVERSY_THRESHOLD,
  FEED_RANKING_VELOCITY_THRESHOLD,
  FEED_RANKING_VELOCITY_SIGMOID_K,
} from './constants'

// ─── R62: Aggregate Logarithmic Dampening ────────────────────────────────────

/**
 * Computes the logarithmically dampened feed score for a content item.
 *
 * Applies log₂ dampening independently to positive and negative aggregate
 * burns, then returns the net score. This creates diminishing returns on
 * spending: a whale must burn exponentially more for each marginal unit of
 * ranking advantage.
 *
 * Formula: log₂(1 + B_pos / BASE) - log₂(1 + B_neg / BASE)
 *
 * Sybil-neutral: operates on aggregate totals only.
 *
 * @param satsPositive - Total positive burns on this content (satoshis)
 * @param satsNegative - Total negative burns on this content (satoshis)
 * @param baseSats - Logarithmic base (default: FEED_RANKING_LOG_BASE_SATS)
 * @returns Net dampened feed score (positive = net positive sentiment)
 */
export function computeAggregateFeedScore(
  satsPositive: bigint,
  satsNegative: bigint,
  baseSats: bigint = FEED_RANKING_LOG_BASE_SATS,
): number {
  const base = Number(baseSats)
  const pos = Math.log2(1 + Number(satsPositive) / base)
  const neg = Math.log2(1 + Number(satsNegative) / base)
  return pos - neg
}

/**
 * Computes only the positive dampened score component.
 * Useful for engagement signal calculations.
 */
export function computePositiveFeedScore(
  satsPositive: bigint,
  baseSats: bigint = FEED_RANKING_LOG_BASE_SATS,
): number {
  return Math.log2(1 + Number(satsPositive) / Number(baseSats))
}

// ─── R63: Cross-Content Z-Score Capping ──────────────────────────────────────

/**
 * Applies z-score normalization and capping to an array of feed scores.
 *
 * Prevents any single content item from monopolizing the feed regardless
 * of absolute burn amount. Items with fewer than FEED_RANKING_ZSCORE_MIN_POSTS
 * entries are returned unchanged (insufficient data for normalization).
 *
 * @param scores - Array of raw feed scores (one per content item)
 * @param zMax - Maximum z-score cap (default: FEED_RANKING_ZSCORE_MAX)
 * @returns Array of z-score-capped scores in the same order
 */
export function applyZScoreCapping(
  scores: number[],
  zMax: number = FEED_RANKING_ZSCORE_MAX,
): number[] {
  if (scores.length < FEED_RANKING_ZSCORE_MIN_POSTS) {
    return scores
  }

  const mean = scores.reduce((sum, s) => sum + s, 0) / scores.length
  const variance =
    scores.reduce((sum, s) => sum + Math.pow(s - mean, 2), 0) / scores.length
  const stddev = Math.sqrt(variance)

  if (stddev === 0) {
    return scores.map(() => 0)
  }

  return scores.map(s => {
    const z = (s - mean) / stddev
    return Math.min(z, zMax)
  })
}

// ─── R64: Temporal Conviction Accumulation ───────────────────────────────────

/**
 * Computes the exponential decay factor for a given age.
 *
 * Based on conviction voting's exponential decay model (Commons Stack / 1Hive).
 * A burn from `ageHours` ago contributes `decay` of its original weight.
 *
 * Formula: decay = (1/2)^(ageHours / halfLifeHours)
 *
 * @param ageHours - Age of the burn in hours
 * @param halfLifeHours - Half-life in hours (default: FEED_RANKING_HALFLIFE_HOURS)
 * @returns Decay factor in [0, 1]
 */
export function computeDecayFactor(
  ageHours: number,
  halfLifeHours: number = FEED_RANKING_HALFLIFE_HOURS,
): number {
  return Math.pow(0.5, ageHours / halfLifeHours)
}

/**
 * Computes a time-weighted conviction score for a content item by applying
 * exponential decay to each time period's aggregate burns.
 *
 * Burns are grouped into hourly periods. Each period's net dampened score
 * (R62) is weighted by its decay factor based on age.
 *
 * Formula: score = Σ_t [ feedScore(period_t) × decay(age_t) ]
 *
 * Sybil-neutral: operates on aggregate burns per period, not per-voter.
 *
 * @param periods - Array of { satsPositive, satsNegative, timestampSeconds }
 * @param nowSeconds - Current Unix timestamp in seconds (default: Date.now()/1000)
 * @param halfLifeHours - Half-life in hours (default: FEED_RANKING_HALFLIFE_HOURS)
 * @returns Conviction-weighted feed score
 */
export function computeTemporalConvictionScore(
  periods: Array<{
    satsPositive: bigint
    satsNegative: bigint
    timestampSeconds: number
  }>,
  nowSeconds: number = Math.floor(Date.now() / 1000),
  halfLifeHours: number = FEED_RANKING_HALFLIFE_HOURS,
): number {
  return periods.reduce((conviction, period) => {
    const ageSeconds = nowSeconds - period.timestampSeconds
    const ageHours = ageSeconds / 3600
    const decay = computeDecayFactor(ageHours, halfLifeHours)
    const periodScore = computeAggregateFeedScore(
      period.satsPositive,
      period.satsNegative,
    )
    return conviction + periodScore * decay
  }, 0)
}

/**
 * Applies temporal decay to a pre-computed feed score based on the age
 * of the content's first vote. Used as a simpler alternative to full
 * per-period conviction when historical period data is unavailable.
 *
 * @param feedScore - Pre-computed aggregate feed score
 * @param firstVotedSeconds - Unix timestamp (seconds) of first vote on this content
 * @param nowSeconds - Current Unix timestamp in seconds
 * @param halfLifeHours - Half-life in hours
 * @returns Temporally decayed feed score
 */
export function applyTemporalDecay(
  feedScore: number,
  firstVotedSeconds: number,
  nowSeconds: number = Math.floor(Date.now() / 1000),
  halfLifeHours: number = FEED_RANKING_HALFLIFE_HOURS,
): number {
  const ageHours = (nowSeconds - firstVotedSeconds) / 3600
  const decay = computeDecayFactor(ageHours, halfLifeHours)
  return feedScore * decay
}

// ─── R65: Bidirectional Signal Integration ───────────────────────────────────

/**
 * Computes bidirectional signal metrics from aggregate positive and negative burns.
 *
 * Returns:
 * - sentimentRatio: fraction of total burns that are positive (0–1)
 * - controversyScore: how evenly contested the burns are (0 = one-sided, 1 = perfectly split)
 * - totalEngagement: log-dampened total of all burns (pos + neg), used as tiebreaker
 * - isControversial: whether the post exceeds the controversy threshold
 *
 * Sybil-neutral: all metrics derived from aggregate totals only.
 *
 * @param satsPositive - Total positive burns (satoshis)
 * @param satsNegative - Total negative burns (satoshis)
 * @param controversyThreshold - Ratio above which content is flagged (default: FEED_RANKING_CONTROVERSY_THRESHOLD)
 * @returns Bidirectional signal metrics
 */
export function computeBidirectionalSignals(
  satsPositive: bigint,
  satsNegative: bigint,
  controversyThreshold: number = FEED_RANKING_CONTROVERSY_THRESHOLD,
): {
  sentimentRatio: number
  controversyScore: number
  totalEngagement: number
  isControversial: boolean
} {
  const pos = Number(satsPositive)
  const neg = Number(satsNegative)
  const total = pos + neg

  if (total === 0) {
    return {
      sentimentRatio: 0.5,
      controversyScore: 0,
      totalEngagement: 0,
      isControversial: false,
    }
  }

  const sentimentRatio = pos / total
  const minSide = Math.min(pos, neg)
  const maxSide = Math.max(pos, neg)
  const controversyScore = maxSide > 0 ? minSide / maxSide : 0
  const totalEngagement = computePositiveFeedScore(
    BigInt(Math.floor(total)),
    FEED_RANKING_LOG_BASE_SATS,
  )
  const isControversial = controversyScore >= controversyThreshold

  return { sentimentRatio, controversyScore, totalEngagement, isControversial }
}

// ─── R66: Burn Velocity Spike Dampening ──────────────────────────────────────

/**
 * Computes a sigmoid dampening factor based on burn velocity.
 *
 * Applies additional dampening when burn accumulation velocity (burns per
 * unit time in the detection window) exceeds a configurable multiple of
 * the rolling median velocity. Specifically targets flash attacks while
 * leaving normal and popular content unaffected.
 *
 * Formula: dampening = 1 / (1 + e^(k × (velocityRatio - threshold)))
 *
 * Sybil-neutral: velocity is computed from aggregate burns per window,
 * not per-wallet. Splitting a 100K sat burn across 100 wallets in the
 * same window produces the same velocity spike.
 *
 * @param currentWindowBurns - Total burns in the detection window (satoshis)
 * @param rollingMedianBurns - Rolling median of burns per window across all content
 * @param threshold - Velocity ratio above which dampening begins (default: FEED_RANKING_VELOCITY_THRESHOLD)
 * @param sigmoidK - Sigmoid steepness (default: FEED_RANKING_VELOCITY_SIGMOID_K)
 * @returns Dampening factor in (0, 1]. 1.0 = no dampening, approaching 0 = heavy dampening.
 */
export function computeVelocityDampening(
  currentWindowBurns: bigint,
  rollingMedianBurns: bigint,
  threshold: number = FEED_RANKING_VELOCITY_THRESHOLD,
  sigmoidK: number = FEED_RANKING_VELOCITY_SIGMOID_K,
): number {
  if (rollingMedianBurns <= 0n) {
    return 1.0
  }
  const velocityRatio =
    Number(currentWindowBurns) / Number(rollingMedianBurns)
  return 1 / (1 + Math.exp(sigmoidK * (velocityRatio - threshold)))
}

// ─── Composite Score ──────────────────────────────────────────────────────────

/**
 * Computes the full composite feed score for a content item, combining
 * R62 (log dampening) and R65 (bidirectional signals).
 *
 * R63 (z-score capping) is applied at the feed-level after all items are
 * scored — see `applyZScoreCapping`.
 *
 * R64 (temporal conviction) is applied here via `firstVotedSeconds` when
 * provided. For full per-period conviction, use `computeTemporalConvictionScore`
 * directly.
 *
 * R66 (velocity dampening) is applied here via `velocityDampening` when
 * provided (pre-computed by the caller from window burn data).
 *
 * @param satsPositive - Total positive burns (satoshis)
 * @param satsNegative - Total negative burns (satoshis)
 * @param firstVotedSeconds - Unix timestamp of first vote (for R64 temporal decay)
 * @param velocityDampening - Pre-computed velocity dampening factor (for R66)
 * @returns Composite feed score and bidirectional signal metrics
 */
export function computeCompositeFeedScore(
  satsPositive: bigint,
  satsNegative: bigint,
  firstVotedSeconds?: number,
  velocityDampening: number = 1.0,
): {
  feedScore: number
  sentimentRatio: number
  controversyScore: number
  totalEngagement: number
  isControversial: boolean
} {
  let feedScore = computeAggregateFeedScore(satsPositive, satsNegative)

  if (firstVotedSeconds !== undefined) {
    feedScore = applyTemporalDecay(feedScore, firstVotedSeconds)
  }

  feedScore *= velocityDampening

  const bidirectional = computeBidirectionalSignals(satsPositive, satsNegative)

  return {
    feedScore,
    ...bidirectional,
  }
}
