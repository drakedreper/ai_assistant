import { NON_BLOCKING_HOOK_EVENTS } from '@ai-assistant/shared'

/**
 * Pure functions that build, merge and remove the Claude Code `hooks` block. No file system access here.
 *
 * The field names (`type: "http"`, `url`, `timeout` in seconds, `headers`, `allowedEnvVars`, `onFailure`) come from
 * the research digests (docs/research/claude-integration.md) and spikes/hooks/settings.snippet.json, NOT from a live
 * read of the Claude Code hooks reference. If Claude Code reports a settings validation error, check
 * https://code.claude.com/docs/en/hooks and adjust buildHandler.
 */

export const TOKEN_ENV_VAR = 'AI_ASSISTANT_HOOK_TOKEN'

export interface HookHandler {
  type: 'http'
  url: string
  /** Seconds. Short on purpose: a slow receiver must never hold a Claude Code session up. */
  timeout: number
  /** A non-2xx reply or a dead daemon is non-blocking. Stated explicitly so it never depends on a default. */
  onFailure: 'continue'
  headers: { Authorization: string }
  allowedEnvVars?: string[]
}

export interface BuildOptions {
  port: number
  /** Write this literal token into the header instead of an environment variable reference. */
  embedToken?: string
  /** Events to leave out (for example PermissionRequest while spike (b) is unproven). */
  skip?: readonly string[]
}

export type HookGroup = { matcher?: string; hooks: unknown[] }
export type HooksBlock = Record<string, HookGroup[]>

export const hookUrl = (port: number, event: string): string => `http://127.0.0.1:${port}/hooks/${event}`

export function eventsFor(opts: Pick<BuildOptions, 'skip'>): string[] {
  const skip = new Set(opts.skip ?? [])
  return NON_BLOCKING_HOOK_EVENTS.filter((e) => !skip.has(e))
}

export function buildHandler(event: string, opts: BuildOptions): HookHandler {
  const embed = opts.embedToken !== undefined
  return {
    type: 'http',
    url: hookUrl(opts.port, event),
    // SessionEnd gets only a 1.5 s budget from Claude Code, so a longer timeout there buys nothing.
    timeout: event === 'SessionEnd' ? 1 : 2,
    onFailure: 'continue',
    headers: { Authorization: `Bearer ${embed ? opts.embedToken : `$${TOKEN_ENV_VAR}`}` },
    ...(embed ? {} : { allowedEnvVars: [TOKEN_ENV_VAR] }),
  }
}

/** The `hooks` block for settings.json: one group per event with a single handler. */
export function buildHooksBlock(opts: BuildOptions): HooksBlock {
  const block: HooksBlock = {}
  for (const event of eventsFor(opts)) block[event] = [{ hooks: [buildHandler(event, opts)] }]
  return block
}

export class SettingsShapeError extends Error {
  override name = 'SettingsShapeError'
}

export type ChangeKind = 'added' | 'updated' | 'unchanged' | 'removed'
export interface Change {
  event: string
  kind: ChangeKind
}

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

function hooksOf(settings: Record<string, unknown>): Record<string, unknown> | undefined {
  if (settings.hooks === undefined) return undefined
  if (!isObject(settings.hooks)) throw new SettingsShapeError('settings.json has a "hooks" value that is not an object; refusing to modify it')
  return settings.hooks
}

/** True for a handler that points exactly at our URL for the event it is registered under. */
export function isOurHandler(handler: unknown, event: string, port: number): boolean {
  return isObject(handler) && handler.url === hookUrl(port, event)
}

/**
 * Add our handlers without touching anything else: the user's other hooks (including other handlers for the same
 * events) stay as they are, a handler that already points at our URL is updated in place, never duplicated.
 */
export function mergeHooks(settings: unknown, opts: BuildOptions): { settings: Record<string, unknown>; changes: Change[] } {
  if (!isObject(settings)) throw new SettingsShapeError('settings.json does not contain a JSON object')
  const next = structuredClone(settings)
  const existing = hooksOf(next)
  const hooks: Record<string, unknown> = existing ?? {}
  const changes: Change[] = []

  for (const event of eventsFor(opts)) {
    const wanted = buildHandler(event, opts)
    const groups = hooks[event]
    if (groups !== undefined && !Array.isArray(groups)) {
      throw new SettingsShapeError(`settings.json hooks.${event} is not an array; refusing to modify it`)
    }
    let kind: ChangeKind | undefined
    for (const group of groups ?? []) {
      if (!isObject(group) || !Array.isArray(group.hooks)) continue
      const idx = group.hooks.findIndex((h: unknown) => isOurHandler(h, event, opts.port))
      if (idx < 0) continue
      if (deepEqual(group.hooks[idx], wanted)) kind = kind ?? 'unchanged'
      else {
        group.hooks[idx] = wanted
        kind = 'updated'
      }
      break
    }
    if (!kind) {
      const list = (groups as unknown[] | undefined) ?? []
      list.push({ hooks: [wanted] })
      hooks[event] = list
      kind = 'added'
    }
    changes.push({ event, kind })
  }
  next.hooks = hooks
  return { settings: next, changes }
}

/** Remove only handlers that point at our URL. Groups, events and the `hooks` key are dropped only if WE emptied them. */
export function removeHooks(settings: unknown, port: number): { settings: Record<string, unknown>; changes: Change[] } {
  if (!isObject(settings)) throw new SettingsShapeError('settings.json does not contain a JSON object')
  const next = structuredClone(settings)
  const hooks = hooksOf(next)
  const changes: Change[] = []
  if (!hooks) return { settings: next, changes }

  for (const event of Object.keys(hooks)) {
    const groups = hooks[event]
    if (!Array.isArray(groups)) continue
    let removed = 0
    const kept: unknown[] = []
    for (const group of groups) {
      if (!isObject(group) || !Array.isArray(group.hooks)) {
        kept.push(group)
        continue
      }
      const handlers: unknown[] = group.hooks
      const remaining = handlers.filter((h) => !isOurHandler(h, event, port))
      const gone = handlers.length - remaining.length
      removed += gone
      group.hooks = remaining
      // Drop the group only when it became empty because of us.
      if (gone > 0 && remaining.length === 0) continue
      kept.push(group)
    }
    if (removed > 0) {
      changes.push({ event, kind: 'removed' })
      if (kept.length === 0) delete hooks[event]
      else hooks[event] = kept
    }
  }
  if (changes.length > 0 && Object.keys(hooks).length === 0) delete next.hooks
  return { settings: next, changes }
}

/** A small unified-style line diff (LCS), enough to review a settings.json change. Returns '' when identical. */
export function lineDiff(before: string, after: string, context = 2): string {
  if (before === after) return ''
  const a = before.split('\n')
  const b = after.split('\n')
  const n = a.length
  const m = b.length
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!)
    }
  }
  const ops: Array<{ t: ' ' | '+' | '-'; s: string }> = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ t: ' ', s: a[i]! })
      i++
      j++
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) ops.push({ t: '-', s: a[i++]! })
    else ops.push({ t: '+', s: b[j++]! })
  }
  while (i < n) ops.push({ t: '-', s: a[i++]! })
  while (j < m) ops.push({ t: '+', s: b[j++]! })

  const keep = new Set<number>()
  ops.forEach((op, idx) => {
    if (op.t === ' ') return
    for (let k = Math.max(0, idx - context); k <= Math.min(ops.length - 1, idx + context); k++) keep.add(k)
  })
  const out: string[] = []
  let last = -2
  ops.forEach((op, idx) => {
    if (!keep.has(idx)) return
    if (idx !== last + 1 && out.length > 0) out.push('...')
    out.push(`${op.t} ${op.s}`)
    last = idx
  })
  return out.join('\n')
}
