import { EXT_INSTANCE_ID_DIFFICULTY, HTTP } from './constants'
import { Block, ScriptChunkPlatformUTF8, Util } from 'lotus-lib'
import { Address, Message, Networks } from 'bitcore-lib-xpi'
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
 * Validates that the provided `instanceId` is a valid instance ID.
 * If invalid, returns false.
 * @returns True if the instance ID is valid, false otherwise
 */
export async function isValidInstanceId({
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
      ['api.error', 'isValidInstanceId'],
      ['error', e.message],
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
  const [authData] = processAuthorizationHeader(header)
  if (!authData) {
    return null
  }
  return authData.scriptPayload
}

/**
 * Processes an authorization header string to extract authorization data, data string and signature
 * @param {string} header - The authorization header string to process, expected in base64 format
 * @returns Tuple containing:
 *   - AuthorizationPayload object or null if invalid
 *   - Raw authorization data string or null if invalid
 *   - Signature string or null if invalid
 */
export function processAuthorizationHeader(
  header: string | undefined,
): [AuthorizationPayload, string, string] {
  if (header === undefined) {
    return [null, null, null]
  }
  const [authPayloadStr, signature] = Util.base64.decode(header).split(':::')
  if (!authPayloadStr || !signature) {
    return [null, null, null]
  }
  const authData = JSON.parse(authPayloadStr ?? '{}') as AuthorizationPayload
  return [authData, authPayloadStr, signature]
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
 * Validator functions for API parameters
 */
export const Validate = {
  /**
   * Validates that the provided `instanceId` is a 64-character hexadecimal string.
   * If invalid, responds with HTTP 400 and an error message.
   * @param instanceId - The instance ID to validate
   * @returns The validated instance ID
   */
  instanceId: (instanceId: string | undefined) => {
    if (instanceId === undefined) {
      return {
        error: 'instanceId must be specified',
        statusCode: HTTP.BAD_REQUEST,
      }
    }
    if (!instanceId.match(/^[a-f0-9]{64}$/)) {
      return {
        error: 'instanceId is invalid format',
        statusCode: HTTP.BAD_REQUEST,
      }
    }
    // TODO: validate instanceId matches input and meets/exceeds difficulty

    return { instanceId }
  },

  /**
   * Validates that the provided `scriptPayload` is a valid script payload.
   * If invalid, responds with HTTP 400 and an error message.
   * @param scriptPayload - The script payload to validate
   * @returns The validated script payload
   */
  scriptPayload: (scriptPayload: string | undefined) => {
    if (scriptPayload === undefined) {
      return {
        error: 'scriptPayload must be specified',
        statusCode: HTTP.BAD_REQUEST,
      }
    }
    return Buffer.from(scriptPayload, 'hex').byteLength === 20
      ? { scriptPayload }
      : {
          error: 'scriptPayload is invalid',
          statusCode: HTTP.BAD_REQUEST,
        }
  },

  /**
   * Validates a message signature
   * @param scriptPayload - PKH used to generate `Address` for signature validation
   * @param data - The data payload to verify against the signature
   * @param signature - The signature of the data payload to validate
   * @returns The validated signature
   */
  signature: ({
    scriptPayload,
    data,
    signature,
  }: {
    scriptPayload: string | undefined
    data: string | undefined
    signature: string | undefined
  }) => {
    if (scriptPayload === undefined) {
      return {
        error: 'scriptPayload must be specified',
        statusCode: HTTP.BAD_REQUEST,
      }
    }
    if (signature === undefined) {
      return {
        error: 'signature must be specified',
        statusCode: HTTP.BAD_REQUEST,
      }
    }
    if (data === undefined) {
      return {
        error: 'data must be specified',
        statusCode: HTTP.BAD_REQUEST,
      }
    }
    // convert scriptPayload to Address
    const address = Address.fromPublicKeyHash(
      Buffer.from(scriptPayload, 'hex'),
      Networks.livenet,
    )
    // verify message signature
    const message = new Message(data)
    if (!message.verify(address, signature)) {
      return {
        error: 'message signature is invalid',
        statusCode: HTTP.BAD_REQUEST,
      }
    }
    return { signature }
  },

  /**
   * Validates a search type
   * @param searchType - The search type to validate
   * @returns The validated search type
   */
  searchType: (searchType: 'profile' | 'post' | undefined) => {
    if (searchType === undefined) {
      return {
        error: 'search type must be specified',
        statusCode: HTTP.BAD_REQUEST,
      }
    }
    if (!['profile', 'post'].includes(searchType)) {
      return {
        error: 'invalid search type specified',
        statusCode: HTTP.BAD_REQUEST,
      }
    }
    return { searchType }
  },
}
