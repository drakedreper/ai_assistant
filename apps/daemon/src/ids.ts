import { randomBytes } from 'node:crypto'

export type IdGen = (prefix: string) => string

/** Short, sortable-ish, collision-resistant ids such as `ev-lq3k9x-1a-9f3c`. */
export function createIdGen(now: () => number = Date.now): IdGen {
  let counter = 0
  return (prefix) => `${prefix}-${now().toString(36)}-${(++counter).toString(36)}-${randomBytes(2).toString('hex')}`
}
