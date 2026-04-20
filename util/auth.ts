import { Block } from 'lotus-nng-client'
import { AuthorizationPayload } from '../lib/api/authCache'
import { isBase64, Util } from './functions'
import { HTTP } from './constants'
import type { Response } from 'express'

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
