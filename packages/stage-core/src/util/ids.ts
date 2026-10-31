/** Id source seam: `newId('utt')` -> "utt_1". The daemon injects a random one; tests use the sequential one. */
export type IdGenerator = (prefix: string) => string

export function createSequentialIds(start = 1): IdGenerator {
  const counters = new Map<string, number>()
  return (prefix: string) => {
    const n = counters.get(prefix) ?? start
    counters.set(prefix, n + 1)
    return `${prefix}_${n}`
  }
}
