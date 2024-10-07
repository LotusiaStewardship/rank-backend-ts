import { Indexer } from "./lib/indexer";
import { NNG_PUB_URL, NNG_RPC_URL, ERR } from "./util/constants";
/**
 * RUNTIME
 */
const indexer = new Indexer(NNG_PUB_URL, NNG_RPC_URL)
indexer.init().catch((e: any) => {
  indexer.close(ERR.UNHANDLED_EXCEPTION, e)
})