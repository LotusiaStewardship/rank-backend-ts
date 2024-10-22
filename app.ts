import { Indexer } from './lib/indexer'
import { NNG_PUB_URL, NNG_RPC_URL } from './util/constants'
/**
 * RUNTIME
 */
const indexer = new Indexer(NNG_PUB_URL, NNG_RPC_URL)
indexer.init()
