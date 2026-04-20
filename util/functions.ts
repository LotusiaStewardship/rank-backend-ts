import {
  EXT_INSTANCE_ID_DIFFICULTY,
  HTTP,
  REFERRAL_CODE_LENGTH,
} from './constants'
import { ScriptChunkPlatformUTF8 } from 'xpi-ts/lib/rank'
import { Block } from 'lotus-nng-client'
import {
  Address,
  BufferUtil,
  Message,
  Networks,
  Script,
  ScriptType,
} from 'xpi-ts/lib/bitcore'
import type { Request, Response } from 'express'
import type { TopicCategory, Topic } from '../lib/push'
import { AuthorizationPayload } from '../lib/api/authCache'

export type LogEntry = [string, string]
export const log = function (entries: LogEntry[]) {
  console.log(
    `${new Date().toISOString()} ${entries
      .map(entry => entry.join('='))
      .join(' ')}`,
  )
}

/**
 * Converts a synchronous iterable to a generator that can be used with `for await...of`
 * @param iterable The synchronous iterable to convert
 * @yields Each item from the iterable
 */
export function* toAsyncIterable<T>(iterable: Iterable<T>) {
  for (const item of iterable) {
    yield item
  }
}

/**
 * Validates that the provided `instanceId` is a valid instance ID.
 * If invalid, returns false.
 * @returns True if the instance ID is valid, false otherwise
 */
export async function recomputeInstanceId({
  instanceId,
  runtimeId,
  startTime,
  nonce,
}: {
  instanceId: string
  runtimeId: string
  startTime: string
  nonce: number
}) {
  try {
    if (!new Date(startTime)?.getTime()) {
      throw new Error('invalid startTime')
    }
    if (!Number.isInteger(nonce)) {
      throw new Error('invalid nonce')
    }
    const data = Buffer.from(`${runtimeId}:${startTime}:${nonce}`)
    const computed = await crypto.subtle.digest('SHA-256', data)
    return (
      instanceId === Buffer.from(computed).toString('hex') &&
      instanceId.substring(0, EXT_INSTANCE_ID_DIFFICULTY) ===
        String().padStart(EXT_INSTANCE_ID_DIFFICULTY, '0')
    )
  } catch (e) {
    log([
      ['api.error', 'recomputeInstanceId'],
      ['error', (e as Error).message],
    ])
    return false
  }
}
/**
 * Generates a push subscription topic string.
 *
 * The topic string is composed as:
 *   `${category}:${platform}:${profileId}` or `${category}:${platform}:${profileId}:${postId}`
 *
 * @param category - The category of the push notification (e.g., stewardship, system, social)
 * @param platform - The platform identifier (e.g., 'twitter', 'lotusia', etc.)
 * @param profileId - The profile identifier
 * @param postId - (Optional) The post identifier for more granular topic scoping
 * @returns The push subscription topic string
 */
export function toPushSubscriptionTopic(
  category: TopicCategory,
  platform: ScriptChunkPlatformUTF8,
  profileId: string,
  postId?: string,
): Topic {
  let topic = `${category}:${platform}:${profileId}`
  if (postId) {
    topic += `:${postId}`
  }
  return topic as Topic
}

/**
 * Converts a request parameter object to an array of key-value pairs for logging
 * @param data The request parameter object to convert
 * @returns An array of key-value pairs for logging
 */
export function toLogEntries(data: Request['params']): [string, string][] {
  return Object.entries(data).map(([k, v]) => [k, String(v)])
}

/**
 * Sends a JSON response with the specified data and status code
 * @param res Express Response object to send the JSON response
 * @param data Object containing the data to be sent as JSON
 * @param statusCode Optional HTTP status code (defaults to HTTP.OK if not provided)
 */
export function sendJSON(res: Response, data: object, statusCode?: number) {
  res
    .contentType('application/json')
    .status(statusCode ?? HTTP.OK)
    .json(data)
}
/**
 * Sends an error JSON response and logs the error
 * @param res Express Response object to send the JSON response
 * @param error The error message to send
 * @param t0 The start time of the request
 * @param statusCode Optional HTTP status code (defaults to HTTP.BAD_REQUEST if not provided)
 */
export function sendAndLogError(
  res: Response,
  error: string | LogEntry[],
  entries: LogEntry[],
  statusCode?: number,
) {
  log(entries)
  sendJSON(res, { error }, statusCode)
}

/**
 * Sends an HTTP "401 Unauthorized" response with a `WWW-Authenticate` header
 * @param res Express Response object to send the response
 * @param checkpoint The latest indexed block to use for the challenge
 */
export function sendAuthChallenge(res: Response, checkpoint: Block) {
  const { hash, height } = checkpoint
  res
    .contentType('text/plain')
    .status(HTTP.UNAUTHORIZED)
    .header(
      'WWW-Authenticate',
      `BlockDataSig blockhash=${hash} blockheight=${height}`,
    )
    .send(`${HTTP.UNAUTHORIZED} Unauthorized`)
}

/**
 * Converts a category and subcategory to a topic string
 * @param category - The category of the topic
 * @param subcategory - The subcategory of the topic
 * @returns The topic string
 */
export function toTopic(category: TopicCategory, subcategory: string): Topic {
  return `${category}:${subcategory}` as Topic
}

/**
 * Extracts the script payload from the authorization header
 * @param authorizationHeader - The authorization header string to process, expected in base64 format
 * @returns The script payload or null if invalid
 */
export function extractScriptPayload(header: string): string | null {
  const result = processAuthorizationHeader(header)
  if (!result) {
    return null
  }
  return result.authData.scriptPayload
}

/**
 * Processes an authorization header string to extract authorization data, data string and signature
 * @param {string} header - The authorization header string to process, expected in base64 format
 * @returns Tuple containing:
 *   - AuthorizationPayload object or null if invalid
 *   - Raw authorization data string or null if invalid
 *   - Signature string or null if invalid
 */
export function processAuthorizationHeader(header: string | undefined): {
  authData: AuthorizationPayload
  authPayloadStr: string
  signature: string
} | null {
  if (header === undefined) {
    return null
  }
  if (!isBase64(header)) {
    return null
  }
  const [authPayloadStr, signature] = Util.base64.decode(header).split(':::')
  if (!authPayloadStr || !signature) {
    return null
  }
  const authData = JSON.parse(authPayloadStr ?? '{}') as AuthorizationPayload
  return {
    authData,
    authPayloadStr,
    signature,
  }
}

/**
 * Validates that the provided string is a valid base64 string
 * @param str - The string to validate
 * @returns True if the string is a valid base64 string, false otherwise
 */
export function isBase64(base64: string): boolean {
  if (typeof base64 !== 'string' || base64.length === 0) return false
  // Check for valid base64 characters, must be length divisible by 4
  return /^[A-Za-z0-9=+/_-]+$/.test(base64) && base64.length % 4 === 0
}

/**
 * Utility functions
 */
export const Util = {
  /** Sha256 operations */
  sha256: {
    /**
     * Validate a sha256 hash
     * @param str - The sha256 hash to validate
     * @returns Whether the sha256 hash is valid
     */
    validate(str: string) {
      return str.match(/^[a-f0-9]{64}$/)
    },
  },
  /** Base64 operations */
  base64: {
    /**
     * Encodes a string to a base64 encoded string
     * @param str The string to encode
     * @returns The base64 encoded string
     */
    encode(str: string) {
      return Buffer.from(str).toString('base64')
    },
    /**
     * Decodes a base64 encoded string
     * @param str The base64 encoded string to decode
     * @returns The decoded string
     */
    decode(str: string) {
      // Don't validate the string; validation should be handled by the caller
      return Buffer.from(str, 'base64').toString('utf8')
    },
  },
  /** Crypto operations */
  crypto: {
    /**
     * Generates a random UUID
     * @returns The random UUID
     */
    randomUUID(): string {
      return crypto.randomUUID()
    },
  },
}
