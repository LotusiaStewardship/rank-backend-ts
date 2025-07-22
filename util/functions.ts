/* eslint-disable @typescript-eslint/no-explicit-any */
import { EXT_INSTANCE_ID_DIFFICULTY } from './constants'

export type LogEntry = [string, string]
export const log = function (entries: LogEntry[]) {
  console.log(
    `${new Date().toISOString()} ${entries
      .map(entry => entry.join('='))
      .join(' ')}`,
  )
}
export async function isValidInstanceId({
  instanceId,
  runtimeId,
  startTime,
  nonce,
}: {
  instanceId: string
  runtimeId: string
  startTime: string
  nonce: number
}) {
  const data = Buffer.from(`${runtimeId}:${startTime}:${nonce}`)
  const computed = await crypto.subtle.digest('SHA-256', data)
  return (
    instanceId === Buffer.from(computed).toString('hex') &&
    instanceId.substring(0, EXT_INSTANCE_ID_DIFFICULTY) ===
      String().padStart(EXT_INSTANCE_ID_DIFFICULTY, '0')
  )
}
