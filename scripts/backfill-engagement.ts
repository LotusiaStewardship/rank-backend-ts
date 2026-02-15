/**
 * Backfill script for WalletEngagement records.
 *
 * Enumerates all distinct scriptPayloads that have cast RANK votes,
 * computes their full engagement profile (EP, tier, streak, etc.),
 * and upserts the results into the WalletEngagement table.
 *
 * Usage:
 *   npx tsx scripts/backfill-engagement.ts
 *
 * This script is idempotent — safe to run multiple times.
 */
import { Database } from '../lib/database'
import { computeFullEngagement } from '../lib/engagement'
import { log } from '../util/functions'
import config from '../config'

async function main() {
  const db = new Database(config.datasourceUrl)

  try {
    await db.connect()
    log([
      ['script', 'backfill-engagement'],
      ['status', 'started'],
    ])

    // Get all distinct voter scriptPayloads
    const scriptPayloads = await db.getDistinctVoterScriptPayloads()
    log([
      ['script', 'backfill-engagement'],
      ['totalWallets', `${scriptPayloads.length}`],
    ])

    let processed = 0
    let errors = 0

    for (const scriptPayload of scriptPayloads) {
      try {
        // Compute full engagement profile
        const engagement = await computeFullEngagement(db, scriptPayload)

        // Get existing record for lifetimeRewards (preserve it)
        const existing = await db.getOrCreateWalletEngagement(scriptPayload)

        // Upsert the engagement data
        await db.upsertWalletEngagement(scriptPayload, {
          ...engagement,
          lifetimeRewards: existing.lifetimeRewards ?? 0n,
        })

        processed++
        if (processed % 100 === 0) {
          log([
            ['script', 'backfill-engagement'],
            ['progress', `${processed}/${scriptPayloads.length}`],
          ])
        }
      } catch (e) {
        errors++
        log([
          ['script', 'backfill-engagement'],
          ['error', `"${String(e)}"`],
          ['scriptPayload', scriptPayload],
        ])
      }
    }

    // Reset broken streaks for wallets that haven't voted recently
    const yesterday = new Date(Date.now() - 2 * 86_400_000) // 2 days ago
    const resetResult = await db.resetBrokenStreaks(yesterday)
    log([
      ['script', 'backfill-engagement'],
      ['streaksReset', `${resetResult.count}`],
    ])

    log([
      ['script', 'backfill-engagement'],
      ['status', 'completed'],
      ['processed', `${processed}`],
      ['errors', `${errors}`],
      ['total', `${scriptPayloads.length}`],
    ])
  } catch (e) {
    log([
      ['script', 'backfill-engagement'],
      ['status', 'fatal'],
      ['error', `"${String(e)}"`],
    ])
    process.exit(1)
  } finally {
    await db.disconnect()
  }
}

main()
