import { RANK_SCRIPT_CHUNKS } from './constants'
// General types
export type IndexerLogEntry = [string, string]
export type PlatformParameters = {
  profileId: {
    len: number
  }
  postId: {
    chunkLength: number
    regex: RegExp
    reader: 'readBigUInt64BE' // additional Buffer reader methods if needed
    type: 'BigInt' | 'Number' | 'String'
  }
}
// RANK script types
export type ScriptChunkLokadUTF8 = 'RANK'
export type ScriptChunkPlatformUTF8 = 'twitter'
export type ScriptChunkSentimentUTF8 = 'positive' | 'negative'
export type ScriptChunkLokadMap = Map<number, ScriptChunkLokadUTF8>
export type ScriptChunkPlatformMap = Map<number, ScriptChunkPlatformUTF8>
export type ScriptChunkSentimentMap = Map<number, ScriptChunkSentimentUTF8>
export type ScriptChunkField =
  | 'lokad'
  | 'sentiment'
  | 'platform'
  | 'profile'
  | 'post'
  | 'comment'
export type ScriptChunk = {
  len: number
  map?: ScriptChunkLokadMap | ScriptChunkPlatformMap | ScriptChunkSentimentMap
}
/** OP_RETURN \<RANK\> \<sentiment\> \<profileId\> [\<postId\> \<comment\>] */
export type RankOutput = {
  platform: string // e.g. Twitter/X.com, etc.
  profileId: string // who the ranking is for
  postId?: string // optional post ID if ranking specific content
  sentiment: string // positive or negative sentiment (can support more)
  comment?: string // optional comment
}
/**  */
export type RankTransaction = RankOutput & {
  txid: string
  height?: number // undefined if mempool
  sats: bigint
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
export type RankTarget = {
  id: string // profileId, postId, etc
  platform: string
  ranking: bigint
  ranks: Omit<RankTransaction, 'profileId' | 'platform'>[] // omit the database relation fields
  votesPositive: number
  votesNegative: number
}
/**  */
export type Profile = RankTarget & {
  posts?: PostMap
}
/**  */
export type Post = RankTarget & {
  profileId: string
}
/**
 * `RankTransaction` objects are converted to a `ProfileMap` for database ops
 *
 * `string` is `profileId`
 */
export type ProfileMap = Map<string, Profile>
export type PostMap = Map<string, Post>
