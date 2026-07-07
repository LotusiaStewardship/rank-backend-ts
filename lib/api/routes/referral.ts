import { Router, Request, Response } from 'express'
import { randomBytes, createHmac } from 'node:crypto'
import { Address, BufferUtil, Message, Networks } from 'xpi-ts/lib/bitcore'
import { Database } from '../../database'
import { Temporal } from '../../temporal'
import {
  sendJSON,
  log,
  toLogEntries,
} from '../../../util/functions'
import { HTTP } from '../../../util/constants'
import {
  validateScriptPayload,
  validateReferralCode,
  validateAdminSecret,
} from '../../../util/validators'
import {
  REFERRAL_CODE_LENGTH,
  REFERRAL_CODE_EXPIRY_HOURS,
  REFERRAL_GENESIS_EXPIRY_HOURS,
  REFERRAL_MAX_OUTSTANDING,
  REFERRAL_MIN_VOTES,
  REFERRAL_REDEEM_IP_LIMIT,
  REFERRAL_GENESIS_REFERRER,
  FAUCET_DRIP_AMOUNTS,
} from '../../../util/constants'
import config from '../../../config'

export function createReferralRouter(db: Database, temporal: Temporal): Router {
  const router = Router({ mergeParams: true })

  // ============================================================
  // POST /referral/generate
  // ============================================================
  router.post('/referral/generate', async (req: Request, res: Response) => {
    const t0 = performance.now()
    try {
      const body = req.body as { scriptPayload: string; signature: string }
      const validated = validateScriptPayload(body.scriptPayload)
      if (!validated.scriptPayload) {
        return sendJSON(res, { error: validated.error }, validated.statusCode)
      }
      const message = `generate-referral:${validated.scriptPayload}`
      try {
        const address = Address.fromPublicKeyHash(
          BufferUtil.from(validated.scriptPayload, 'hex'),
          Networks.livenet,
        )
        if (!new Message(message).verify(address, body.signature)) {
          return sendJSON(
            res,
            { error: 'invalid signature' },
            HTTP.UNAUTHORIZED,
          )
        }
      } catch {
        return sendJSON(res, { error: 'invalid signature' }, HTTP.UNAUTHORIZED)
      }
      const voteCount = await db.countRankTxsByScriptPayload(
        validated.scriptPayload,
      )
      if (voteCount < REFERRAL_MIN_VOTES) {
        return sendJSON(
          res,
          {
            error: `must have at least ${REFERRAL_MIN_VOTES} vote(s) to generate referral codes`,
            currentVotes: voteCount,
          },
          HTTP.FORBIDDEN,
        )
      }
      const outstanding = await db.countOutstandingReferralCodes(
        validated.scriptPayload,
      )
      if (outstanding >= REFERRAL_MAX_OUTSTANDING) {
        return sendJSON(
          res,
          {
            error: `maximum of ${REFERRAL_MAX_OUTSTANDING} outstanding referral codes reached`,
            outstanding,
          },
          HTTP.TOO_MANY_REQUESTS,
        )
      }
      const nonce = randomBytes(16).toString('hex')
      const hmac = createHmac('sha256', config.referral.secret)
      hmac.update(`${validated.scriptPayload}:${nonce}:${Date.now()}`)
      const code = hmac.digest('hex').slice(0, REFERRAL_CODE_LENGTH)
      const expiresAt = new Date(
        Date.now() + REFERRAL_CODE_EXPIRY_HOURS * 3_600_000,
      )
      const record = await db.createReferralCode(
        code,
        validated.scriptPayload,
        expiresAt,
      )
      const t1 = (performance.now() - t0).toFixed(3)
      log([
        ['api', 'post.referralGenerate'],
        ['referrer', validated.scriptPayload],
        ['code', code],
        ['elapsed', `${t1}ms`],
      ])
      return sendJSON(
        res,
        {
          code: record.code,
          expiresAt: record.expiresAt.toISOString(),
          outstanding: outstanding + 1,
        },
        HTTP.CREATED,
      )
    } catch (e) {
      const t1 = (performance.now() - t0).toFixed(3)
      log([
        ['api', 'error'],
        ['action', 'post.referralGenerate'],
        ['message', `"${String(e)}"`],
        ['elapsed', `${t1}ms`],
      ])
      return sendJSON(
        res,
        { error: (e as Error).message },
        HTTP.INTERNAL_SERVER_ERROR,
      )
    }
  })

  // ============================================================
  // POST /referral/redeem
  // ============================================================
  router.post('/referral/redeem', async (req: Request, res: Response) => {
    const t0 = performance.now()
    try {
      const body = req.body as {
        code: string
        scriptPayload: string
        signature: string
      }
      const validatedCode = validateReferralCode(body.code)
      if (!validatedCode.code) {
        return sendJSON(
          res,
          { error: validatedCode.error },
          validatedCode.statusCode,
        )
      }
      const validated = validateScriptPayload(body.scriptPayload)
      if (!validated.scriptPayload) {
        return sendJSON(res, { error: validated.error }, validated.statusCode)
      }
      const message = `redeem-referral:${validatedCode.code}:${validated.scriptPayload}`
      try {
        const address = Address.fromPublicKeyHash(
          BufferUtil.from(validated.scriptPayload, 'hex'),
          Networks.livenet,
        )
        if (!new Message(message).verify(address, body.signature)) {
          return sendJSON(
            res,
            { error: 'invalid signature' },
            HTTP.UNAUTHORIZED,
          )
        }
      } catch {
        return sendJSON(res, { error: 'invalid signature' }, HTTP.UNAUTHORIZED)
      }
      const clientIp =
        (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ||
        req.socket.remoteAddress ||
        'unknown'
      const recentRedemptions = await db.countRecentRedemptionsByIp(clientIp)
      if (recentRedemptions >= REFERRAL_REDEEM_IP_LIMIT) {
        return sendJSON(
          res,
          { error: 'too many redemptions from this IP address' },
          HTTP.TOO_MANY_REQUESTS,
        )
      }
      const referral = await db.getReferralCode(validatedCode.code)
      if (!referral) {
        return sendJSON(
          res,
          { error: 'referral code not found' },
          HTTP.NOT_FOUND,
        )
      }
      if (referral.redeemedAt) {
        return sendJSON(
          res,
          { error: 'referral code has already been redeemed' },
          HTTP.CONFLICT,
        )
      }
      if (referral.expiresAt < new Date()) {
        return sendJSON(res, { error: 'referral code has expired' }, HTTP.GONE)
      }
      if (referral.referrerPayload === validated.scriptPayload) {
        return sendJSON(
          res,
          { error: 'cannot redeem your own referral code' },
          HTTP.FORBIDDEN,
        )
      }
      const existingClaim = await db.getFaucetClaim(validated.scriptPayload)
      if (existingClaim) {
        return sendJSON(
          res,
          { error: 'wallet has already redeemed a referral code' },
          HTTP.CONFLICT,
        )
      }
      await db.redeemReferralCode(
        validatedCode.code,
        validated.scriptPayload,
        clientIp,
      )
      await db.createFaucetClaim(validated.scriptPayload, validatedCode.code)
      try {
        await temporal.client.workflow.signalWithStart(
          config.temporal.command.workflowType,
          {
            signal: config.temporal.command.signal,
            taskQueue: config.temporal.taskQueue,
            workflowId: config.temporal.command.workflowId,
            signalArgs: [
              {
                action: 'faucetDrip',
                data: {
                  scriptPayload: validated.scriptPayload,
                  milestone: 1,
                  amount: FAUCET_DRIP_AMOUNTS[0].toString(),
                  referrerPayload: referral.referrerPayload,
                },
              },
            ],
          },
        )
      } catch (temporalError) {
        log([
          ['api', 'warn'],
          ['action', 'post.referralRedeem.temporal'],
          ['message', `"${String(temporalError)}"`],
        ])
      }
      const t1 = (performance.now() - t0).toFixed(3)
      log([
        ['api', 'post.referralRedeem'],
        ['redeemer', validated.scriptPayload],
        ['referrer', referral.referrerPayload],
        ['code', validatedCode.code],
        ['elapsed', `${t1}ms`],
      ])
      return sendJSON(
        res,
        {
          redeemed: true,
          referrerPayload: referral.referrerPayload,
          milestone: 1,
          dripAmount: FAUCET_DRIP_AMOUNTS[0].toString(),
        },
        HTTP.OK,
      )
    } catch (e) {
      const t1 = (performance.now() - t0).toFixed(3)
      log([
        ['api', 'error'],
        ['action', 'post.referralRedeem'],
        ['message', `"${String(e)}"`],
        ['elapsed', `${t1}ms`],
      ])
      return sendJSON(
        res,
        { error: (e as Error).message },
        HTTP.INTERNAL_SERVER_ERROR,
      )
    }
  })

  // ============================================================
  // POST /admin/referral/genesis
  // ============================================================
  router.post(
    '/admin/referral/genesis',
    async (req: Request, res: Response) => {
      const t0 = performance.now()
      try {
        const adminHeader = req.headers['x-admin-secret'] as string | undefined
        const adminValidated = validateAdminSecret(
          adminHeader,
          config.admin.secret,
        )
        if (!adminValidated.valid) {
          return sendJSON(
            res,
            { error: adminValidated.error },
            adminValidated.statusCode,
          )
        }
        const body = req.body as { count?: number }
        const count = Math.min(Math.max(body.count || 1, 1), 50)
        const codes: Array<{
          code: string
          referrerPayload: string
          expiresAt: Date
        }> = []
        const expiresAt = new Date(
          Date.now() + REFERRAL_GENESIS_EXPIRY_HOURS * 3_600_000,
        )
        for (let i = 0; i < count; i++) {
          const nonce = randomBytes(16).toString('hex')
          const hmac = createHmac('sha256', config.referral.secret)
          hmac.update(
            `${REFERRAL_GENESIS_REFERRER}:${nonce}:${Date.now()}:${i}`,
          )
          const code = hmac.digest('hex').slice(0, REFERRAL_CODE_LENGTH)
          codes.push({
            code,
            referrerPayload: REFERRAL_GENESIS_REFERRER,
            expiresAt,
          })
        }
        const result = await db.createReferralCodeBatch(codes)
        const t1 = (performance.now() - t0).toFixed(3)
        log([
          ['api', 'post.referralGenesis'],
          ['count', `${result.count}`],
          ['elapsed', `${t1}ms`],
        ])
        return sendJSON(
          res,
          {
            created: result.count,
            codes: codes.map(c => ({
              code: c.code,
              expiresAt: c.expiresAt.toISOString(),
            })),
          },
          HTTP.CREATED,
        )
      } catch (e) {
        const t1 = (performance.now() - t0).toFixed(3)
        log([
          ['api', 'error'],
          ['action', 'post.referralGenesis'],
          ['message', `"${String(e)}"`],
          ['elapsed', `${t1}ms`],
        ])
        return sendJSON(
          res,
          { error: (e as Error).message },
          HTTP.INTERNAL_SERVER_ERROR,
        )
      }
    },
  )

  return router
}
