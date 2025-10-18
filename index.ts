import { Database } from './lib/database'
import { SubscriptionManager } from './lib/push'
import { RuntimeState } from './lib/state'
import { Indexer } from './lib/indexer'
import { AuthorizationCache } from './lib/api/authCache'
import { API } from './lib/api'
import { PushAPI } from './lib/api-push'
import { log } from './util/functions'
import {
  ERR,
  NNG_PUB_DEFAULT_SOCKET_PATH,
  NNG_RPC_DEFAULT_SOCKET_PATH,
} from './util/constants'

type Exception = [number | string, string]
/**
 * SETUP
 */
// Instantiate all required modules
const db = new Database(process.env.DATABASE_URL)
const subscriptionManager = new SubscriptionManager(db)
const state = new RuntimeState()
const indexer = new Indexer({
  state,
  db,
  subscriptionManager,
  pubUri: String(process.argv[2] || NNG_PUB_DEFAULT_SOCKET_PATH), // /path/to/pub.pipe
  rpcUri: String(process.argv[3] || NNG_RPC_DEFAULT_SOCKET_PATH), // /path/to/rpc.pipe
})
const authCache = new AuthorizationCache(state)
const api = new API({
  authCache,
  routers: [],
  state,
  db,
})
const pushApi = new PushAPI({ subscriptionManager, authCache, state, db })
// Event/Signal handlers
process.once('SIGINT', close)
process.once('SIGTERM', close)
indexer.once('exception', close)
api.once('exception', close)
pushApi.once('exception', close)
/**
 * Gracefully shuts down all running services and disconnects from resources.
 *
 * @param exitCode The exit code or signal that triggered the shutdown. If a string is
 * provided, the process will exit with code 0.
 * @param exitError Optional error message describing the reason for a fatal shutdown.
 */
async function close(exitCode: number | string, exitError?: string) {
  try {
    await api.close()
    await pushApi.close()
    await indexer.close()
    await db.disconnect()
    subscriptionManager.close()
  } catch (e) {
    // ignore
  }
  if (exitError?.length) {
    log([
      ['shutdown', 'fatal'],
      ['error', `${ERR[exitCode]}`],
      [`code`, `${exitCode}`],
      [`debug`, `${exitError}`],
    ])
  } else {
    log([
      ['shutdown', 'clean'],
      ['signal', `${exitCode}`],
    ])
  }
  // Next time the check queue is processed, we will exit
  // SIGINT/SIGTERM are clean shutdowns; if exitCode == string then exitCode == 0
  setImmediate(() => process.exit(typeof exitCode == 'string' ? 0 : exitCode))
}
/**
 * RUNTIME
 */
;(async () => {
  await db.connect()
  log([
    ['init', 'database'],
    ['status', 'connected'],
  ])
  await subscriptionManager.init()
  await indexer.init()
  await api.init()
  await pushApi.init()
})().catch(e => {
  const [exitCode, exitError] = e as Exception
  return close(ERR[exitCode], exitError)
})
