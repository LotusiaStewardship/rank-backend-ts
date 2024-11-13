import Indexer from '../lib/indexer'
/**
 * RUNTIME
 */
const indexer = new Indexer(
  String(process.argv[2]), // /path/to/pub.pipe
  String(process.argv[3]), // /path/to/rpc.pipe
)
indexer.init()
