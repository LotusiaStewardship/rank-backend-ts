import Indexer from '../lib/indexer'
import API from '../lib/api'
import { log } from '../submodules/rank-lib'
import {
  ERR,
  NNG_PUB_DEFAULT_SOCKET_PATH,
  NNG_RPC_DEFAULT_SOCKET_PATH,
} from '../util/constants'
import Database from '../lib/database'

type Exception = [number | string, string]
/**
 * SETUP
 */
// Modules
const db = new Database()
const indexer = new Indexer(
  db,
  String(process.argv[2]), // /path/to/pub.pipe
  String(process.argv[3]), // /path/to/rpc.pipe
)
const api = new API(db)
// Startup/Shutdown functions
const init = async () => {
  try {
    await db.connect()
    log([
      ['init', 'database'],
      ['status', 'connected'],
    ])
    await indexer.init()
    await api.init()
  } catch (e) {
    const [exitCode, exitError] = e as Exception
    return close(ERR[exitCode], exitError)
  }
}
const close = async (exitCode: number | string, exitError?: string) => {
  try {
    await api.close()
    await indexer.close()
    await db.disconnect()
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
// Event/Signal handlers
process.once('SIGINT', close)
process.once('SIGTERM', close)
indexer.once('exception', close)
api.once('exception', close)
/**
 * RUNTIME
 */
init()
