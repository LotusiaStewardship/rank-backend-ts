import {
  Address,
  BufferUtil,
  Message,
  Networks,
  Script,
} from 'xpi-ts/lib/bitcore'
import { HTTP, REFERRAL_CODE_LENGTH } from './constants'
import type { ScriptType } from 'xpi-ts/lib/bitcore'

/**
 * Validates that the provided `instanceId` is a 64-character hexadecimal string.
 * If invalid, responds with HTTP 400 and an error message.
 * @param instanceId - The instance ID to validate
 * @returns The validated instance ID
 */
export function validateInstanceId(instanceId: string | undefined) {
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
}

/**
 * Validates that the provided `scriptPayload` is a valid script payload.
 * If invalid, responds with HTTP 400 and an error message.
 * Accepts both P2PKH/P2SH (20 bytes) and Taproot (33 bytes) scriptPayloads.
 * @param scriptPayload - The script payload to validate
 * @returns The validated script payload
 */
export function validateScriptPayload(scriptPayload: string | undefined) {
  if (scriptPayload === undefined) {
    return {
      error: 'scriptPayload must be specified',
      statusCode: HTTP.BAD_REQUEST,
    }
  }
  const buffer = BufferUtil.from(scriptPayload, 'hex')
  let scriptType: ScriptType
  if (buffer.byteLength === 20) {
    scriptType = 'p2pkh'
  } else if (buffer.byteLength === 33) {
    scriptType = 'p2tr-commitment'
  } else {
    return {
      error: 'scriptPayload is unsupported type',
      statusCode: HTTP.BAD_REQUEST,
    }
  }

  // Valid scriptPayload length, now validate the format
  try {
    const script = Script.fromPayload(scriptType, buffer)
    if (script.isValid()) {
      return {
        scriptPayload,
      }
    }
  } catch (e) {
    // no special handling here is necessary
  }

  return {
    error: 'scriptPayload is invalid',
    statusCode: HTTP.BAD_REQUEST,
  }
}

/**
 * Validates a message signature
 * @param scriptPayload - PKH used to generate `Address` for signature validation
 * @param data - The data payload to verify against the signature
 * @param signature - The signature of the data payload to validate
 * @returns The validated signature
 */
export function validateSignature({ scriptPayload, data, signature }) {
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
    BufferUtil.from(scriptPayload, 'hex'),
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
}

/**
 * Validates a search type
 * @param searchType - The search type to validate
 * @returns The validated search type
 */
export function validateSearchType(searchType: 'profile' | 'post' | undefined) {
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
}

/**
 * Validates that the provided referral code is a valid hex string of the expected length
 * @param code - The referral code to validate
 * @returns The validated referral code or an error
 */
export function validateReferralCode(code: string | undefined) {
  if (code === undefined || code.length === 0) {
    return {
      error: 'referral code must be specified',
      statusCode: HTTP.BAD_REQUEST,
    }
  }
  const regex = new RegExp(`^[a-f0-9]{${REFERRAL_CODE_LENGTH}}$`)
  if (!regex.test(code)) {
    return {
      error: `referral code must be a ${REFERRAL_CODE_LENGTH}-character hex string`,
      statusCode: HTTP.BAD_REQUEST,
    }
  }
  return { code }
}

/**
 * Validates the admin secret header against the configured ADMIN_SECRET
 * @param header - The admin secret header value
 * @param configuredSecret - The configured admin secret from environment
 * @returns Success or error
 */
export function validateAdminSecret(
  header: string | undefined,
  configuredSecret: string | undefined,
) {
  if (!configuredSecret) {
    return {
      error: 'admin endpoint not configured',
      statusCode: HTTP.NOT_FOUND,
    }
  }
  if (header === undefined || header.length === 0) {
    return {
      error: 'admin secret must be specified',
      statusCode: HTTP.UNAUTHORIZED,
    }
  }
  if (header !== configuredSecret) {
    return {
      error: 'invalid admin secret',
      statusCode: HTTP.FORBIDDEN,
    }
  }
  return { valid: true }
}
