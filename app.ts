import { Indexer } from './lib/indexer'
/**
 * RUNTIME
 */
const indexer = new Indexer(
  String(process.argv[2]) as 'ipc' | 'tcp', // protocol
  String(process.argv[3]), // pub.pipe
  String(process.argv[4]), // rpc.pipe
)
indexer.init()
