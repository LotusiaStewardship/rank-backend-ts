/** */
export type IndexerLogEntry = [string, string]
export function log(entries: IndexerLogEntry[]) {
  console.log(
    `${new Date().toISOString()} ${entries.map(entry => entry.join('=')).join(' ')}`,
  )
}
