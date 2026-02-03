import { log, processAuthorizationHeader, Validate } from '../../util/functions'
import { API_AUTH_CACHE_ENTRY_TTL } from '../../util/constants'
import type { RuntimeState } from '../state'

/**
 * Represents the payload sent by an extension to authenticate with the API.
 */
export interface AuthorizationPayload {
  /** Unique identifier for the extension instance. */
  instanceId: string
  /** The script payload used for authentication. */
  scriptPayload: string
  /** The block hash used for authentication. */
  blockhash: string
  /** The block height used for authentication. */
  blockheight: string
}
/**
 * Represents an entry in the authentication cache for an extension instance
 * @property {string} scriptPayload - The script payload used for authentication
 * @property {string} authDataStr - Stringified `AuthorizationPayload` object
 * @property {number} expiresAt - Block height at which the instance authorization will expire
 */
export interface AuthorizationCacheEntry {
  /** The script payload used for authentication. */
  scriptPayload: string
  /** Stringified `AuthorizationPayload` object */
  authPayloadStr: string
  /** Block height at which the instance authorization will expire */
  expiresAt: number
}
/** Runtime cache of authenticated instances, where string is the `instanceId` */
export type Cache = Map<string, AuthorizationCacheEntry>
/**
 * AuthorizationCache is responsible for managing a runtime cache of authenticated extension instances.
 * It stores and validates authorization payloads for each instance, allowing efficient authorization checks
 * for incoming API requests. The cache automatically expires entries based on block height.
 *
 * Usage:
 *   - Call `isRequestAuthorized` to check if a request is authorized.
 *   - The cache is keyed by `instanceId` and stores the associated script payload, authorization payload string,
 * and expiry.
 *
 * @class AuthorizationCache
 * @param {RuntimeState} state - The runtime state used to determine cache expiry.
 */
export class AuthorizationCache {
  private cache: Cache
  private state: RuntimeState

  constructor(state: RuntimeState) {
    this.state = state
    this.cache = new Map()
  }

  /**
   * Checks if a request is authorized based on the provided instanceId and authorization header.
   *
   * This method processes the authorization header, validates the instanceId, checks for cache expiry,
   * and verifies the authentication challenge if necessary. If the request is authorized, it ensures
   * the instanceId is present in the cache and the authorization payload matches.
   *
   * @param {string} instanceId - The unique identifier for the extension instance making the request.
   * @param {string} authorizationHeader - The authorization header string provided with the request.
   * @returns {boolean} Returns true if the request is authorized, false otherwise.
   */
  isRequestAuthorized(
    instanceId: string,
    authorizationHeader: string,
  ): boolean {
    try {
      const [authData, authPayloadStr, signature] =
        processAuthorizationHeader(authorizationHeader)
      // make sure the instanceId is provided
      if (!authData?.instanceId) {
        return false
      }
      if (authData.instanceId !== instanceId) {
        return false
      }
      // If the auth cache entry is no longer valid, delete it
      if (this.isAuthCacheEntryExpired(instanceId)) {
        this.cache.delete(instanceId)
      }
      // Process the request as an authenticate challenge if authorization
      // is not cached for the instanceId
      // Also process as an authenticate challenge if there is a cached entry
      // and the scriptPayload does not match the cached entry
      const hasCachedEntry = this.cache.has(instanceId)
      if (
        !hasCachedEntry ||
        (hasCachedEntry &&
          this.cache.get(instanceId).scriptPayload !== authData.scriptPayload)
      ) {
        // returning false will trigger check for `Authorization: BlockDataSig` header
        if (
          !this.handleAuthChallenge({
            authData,
            authPayloadStr,
            signature,
            scriptPayload: authData.scriptPayload,
          })
        ) {
          return false
        }
        // If the auth challenge succeeds, add the instanceId to the auth cache
        this.cache.set(instanceId, {
          scriptPayload: authData.scriptPayload,
          authPayloadStr,
          expiresAt: this.state.checkpoint.height + API_AUTH_CACHE_ENTRY_TTL,
        })
      }
      // cache entry should exist at this point
      const cacheEntry = this.cache.get(instanceId) as AuthorizationCacheEntry
      if (
        authPayloadStr &&
        cacheEntry.authPayloadStr !== authPayloadStr &&
        cacheEntry.scriptPayload !== authData.scriptPayload
      ) {
        return false
      }
      // return authorized
      return true
    } catch (e) {
      // log the error
      log([
        ['error', 'AuthorizationCache.isRequestAuthorized'],
        ['message', e.message],
      ])
      return false
    }
  }

  /**
   * Checks if the auth cache entry is expired
   * @param instanceId - The instanceId to check
   * @returns true if the auth cache entry is expired, false otherwise
   */
  private isAuthCacheEntryExpired(instanceId: string) {
    const authCacheEntry = this.cache.get(instanceId)
    if (!authCacheEntry) {
      return true
    }
    return authCacheEntry.expiresAt < this.state.checkpoint.height
  }

  /**
   * Handles authentication challenge validation for wallet-specific API requests
   * Verifies the provided authentication data against the current blockchain checkpoint
   * and authorizes the instance if validation is successful
   * @returns true if the authentication is valid, false otherwise
   */
  private handleAuthChallenge({
    authData,
    authPayloadStr,
    signature,
    scriptPayload,
  }: {
    authData: AuthorizationPayload
    authPayloadStr: string
    signature: string
    scriptPayload: string
  }) {
    if (!authData?.blockhash || !authData?.blockheight || !signature) {
      return false
    }
    // validate provided blockhash and blockheight against checkpoint
    if (
      authData.blockhash !== this.state.checkpoint.hash ||
      authData.blockheight !== this.state.checkpoint.height.toString()
    ) {
      return false
    }
    // validate the signature using the scriptPayload in the request path
    if (
      !this.authBlockDataSig({
        scriptPayload,
        data: authPayloadStr,
        signature,
      })
    ) {
      return false
    }
    return true
  }

  /**
   * Validates the authorization using blockchain data and signature.
   * The validation combines the blockhash and blockheight as a message and verifies
   * that the signature was created using the private key of the `scriptPayload`.
   * @param {Object} payload - The authorization data object
   * @param {string} payload.scriptPayload - The script payload to validate against
   * @param {string} payload.data - The JSON-encoded payload to validate
   * @param {string} payload.signature - The cryptographic signature created by signing the data with the private key
   * @returns {boolean} True if the signature is valid for the given scriptPayload and block data, false otherwise
   */
  private authBlockDataSig(payload: {
    scriptPayload: string
    data: string
    signature: string
  }): boolean {
    return !!Validate.signature(payload).signature
  }
}
