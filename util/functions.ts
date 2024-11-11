import {
  PLATFORMS,
  SCRIPT_CHUNK_PLATFORM,
  SCRIPT_CHUNK_SENTIMENT,
} from './constants'
import type {
  Block,
  RankTransaction,
  ScriptChunkLokadUTF8,
  ScriptChunkPlatformUTF8,
  ScriptChunkSentimentUTF8,
  IndexerLogEntry,
} from './types'
/** */
/**
 * Convert the `OP_RETURN` profile name back to UTF-8 with null bytes removed
 * @param profileIdBuf
 */
export const toProfileUTF8 = function (profileIdBuf: Buffer) {
  return new TextDecoder('utf-8').decode(
    profileIdBuf.filter(byte => byte != 0x00),
  )
}
/**
 * Convert the defined 1-byte platform hex code to the UTF-8 platform name
 * @param platformBuf
 */
export const toPlatformUTF8 = function (
  platformBuf: Buffer,
): ScriptChunkPlatformUTF8 | undefined {
  return SCRIPT_CHUNK_PLATFORM.get(platformBuf.readUint8())
}
/**
 * Convert the defined 1-byte sentiment hex code to the UTF-8 sentiment name
 * @param sentimentBuf
 */
export const toSentimentUTF8 = function (
  sentimentBuf: Buffer,
): ScriptChunkSentimentUTF8 | undefined {
  return SCRIPT_CHUNK_SENTIMENT.get(sentimentBuf.readUint8())
}
/**
 *
 * @param entries
 */
export const log = function (entries: IndexerLogEntry[]) {
  console.log(
    `${new Date().toISOString()} ${entries.map(entry => entry.join('=')).join(' ')}`,
  )
}
