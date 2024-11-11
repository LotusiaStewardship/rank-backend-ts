import { RANK_SCRIPT_CHUNKS } from './constants'
// General types
export type IndexerLogEntry = [string, string]
export type PlatformParameters = {
  profileMaxLength: number
}
// RANK script types
export type ScriptChunkLokadUTF8 = 'RANK'
export type ScriptChunkPlatformUTF8 = 'WEB_URL' | 'TWITTER'
export type ScriptChunkSentimentUTF8 = 'POSITIVE' | 'NEGATIVE'
export type ScriptChunkLokadMap = Map<number, ScriptChunkLokadUTF8>
export type ScriptChunkPlatformMap = Map<number, ScriptChunkPlatformUTF8>
export type ScriptChunkSentimentMap = Map<number, ScriptChunkSentimentUTF8>
export type ScriptChunkField = keyof typeof RANK_SCRIPT_CHUNKS
export type ScriptChunk = {
  offset: number
  len: number
  map?: ScriptChunkLokadMap | ScriptChunkPlatformMap | ScriptChunkSentimentMap
}
/** OP_RETURN \<RANK\> \<sentiment\> \<profileId\> [\<postId\> \<comment\>] */
export type RankOutput = {
  platform: string // e.g. Twitter/X.com, etc.
  profileId: string // who the ranking is for
  sentiment: string // positive or negative sentiment (can support more)
  sats: bigint // sats for sentiment
}
/**  */
export type RankTransaction = RankOutput & {
  txid: string
  height?: number // undefined if mempool
  timestamp: bigint // unix timestamp
}
/** */
export type Block = {
  hash: string
  height: number
  timestamp: bigint
  ranksLength: number // default is 0 if a block is cringe
  prevhash?: string // for reorg checks only; does not get saved to database
}
/**  */
export type Profile = {
  id: string
  platform: string
  ranking: bigint
  ranks: Omit<RankTransaction, 'profileId' | 'platform'>[] // omit the database relation fields
  votesPositive: number
  votesNegative: number
}
/**
 * `RankTransaction` objects are converted to a `ProfileMap` for database ops
 *
 * `string` is `profileId`
 */
export type ProfileMap = Map<string, Profile>
