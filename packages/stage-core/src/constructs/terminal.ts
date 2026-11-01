/**
 * terminal_pane helpers: bind a construct to one of the daemon's PTY terminals, chunk PTY output into
 * `construct.terminal.write` commands and vet keystrokes coming back from the stage.
 *
 * PRIVACY: terminal bytes can contain secrets. Nothing here logs, stores or echoes them; errors and results carry only
 * lengths and ids. The daemon still applies its own checks before forwarding input to the PTY.
 */
import type { DataConstruct, Transform } from '@ai-assistant/shared'
import type { CommandDraft } from '../util/commands'
import { identityTransform } from '../scene/math'
import { fail, ok } from '../util/result'
import type { Result } from '../util/result'
import { isSafeId } from '../util/safe'
import { clampFinite } from '../util/math'

export interface TerminalPaneOptions {
  id?: string
  terminalId: string
  transform?: Transform
  /** Pane size in world units multiplier. */
  scale?: number
}

/** The DataConstruct for a terminal pane bound to a PTY terminal id. */
export function createTerminalPaneConstruct(opts: TerminalPaneOptions): DataConstruct {
  const t = opts.transform ?? { ...identityTransform(), position: [0, 1.5, 3] }
  return {
    id: opts.id ?? `term_${opts.terminalId}`,
    kind: 'terminal_pane',
    transform: t,
    source: 'terminal',
    query: { terminalId: opts.terminalId },
    style: { palette: 'mono', density: 0.5, scale: opts.scale ?? 1 },
    interactive: true,
  }
}

export const MAX_WRITE_CHUNK = 16 * 1024
export const MAX_INPUT_CHUNK = 4 * 1024
export const MIN_COLS = 20
export const MAX_COLS = 400
export const MIN_ROWS = 5
export const MAX_ROWS = 200

/**
 * Split terminal output into command-sized chunks without breaking a UTF-16 surrogate pair. Terminates for ANY `max`: it
 * is clamped to at least 2 (a surrogate pair), so every chunk makes progress; NaN means the default; Infinity means the
 * largest chunk allowed (64 KiB).
 */
export function chunkTerminalOutput(data: string, max: number = MAX_WRITE_CHUNK): string[] {
  if (typeof data !== 'string' || data.length === 0) return []
  const size = clampFinite(Math.floor(max), 2, 64 * 1024, MAX_WRITE_CHUNK)
  const out: string[] = []
  for (let i = 0; i < data.length; ) {
    let end = Math.min(data.length, i + size)
    if (end < data.length) {
      const c = data.charCodeAt(end - 1)
      if (c >= 0xd800 && c <= 0xdbff && end - 1 > i) end-- // do not split a surrogate pair (with size >= 2 there is always room to step back)
    }
    out.push(data.slice(i, end))
    i = end
  }
  return out
}

export interface TerminalInput {
  terminalId: string
  data: string
}
export interface TerminalResize {
  terminalId: string
  cols: number
  rows: number
}

/** Maps construct ids to terminal ids both ways. */
export class TerminalBindings {
  private readonly byConstruct = new Map<string, string>()

  bind(constructId: string, terminalId: string): Result<true> {
    if (!isSafeId(constructId) || !isSafeId(terminalId)) return fail('invalid_input', 'construct and terminal ids must be path-safe')
    this.byConstruct.set(constructId, terminalId)
    return ok(true)
  }
  unbind(constructId: string): boolean {
    return this.byConstruct.delete(constructId)
  }
  terminalOf(constructId: string): string | undefined {
    return this.byConstruct.get(constructId)
  }
  constructsOf(terminalId: string): string[] {
    return [...this.byConstruct.entries()].filter(([, t]) => t === terminalId).map(([c]) => c)
  }

  /** `construct.terminal.write` commands for PTY output of a terminal, one per bound pane and chunk. */
  writeCommands(terminalId: string, data: string): CommandDraft[] {
    const out: CommandDraft[] = []
    for (const constructId of this.constructsOf(terminalId)) {
      for (const chunk of chunkTerminalOutput(data)) out.push({ type: 'construct.terminal.write', constructId, data: chunk })
    }
    return out
  }

  /** Vet a `construct.terminal.input` event from the stage; the daemon forwards the result to the PTY after its own checks. */
  routeInput(ev: { constructId: string; data: string }): Result<TerminalInput> {
    const terminalId = this.byConstruct.get(ev.constructId)
    if (!terminalId) return fail('not_bound', 'that pane is not bound to a terminal')
    if (typeof ev.data !== 'string' || ev.data.length === 0) return fail('invalid_input', 'empty input')
    if (ev.data.length > MAX_INPUT_CHUNK) return fail('too_large', `input is limited to ${MAX_INPUT_CHUNK} characters per event`)
    return ok({ terminalId, data: ev.data })
  }

  /** Vet a resize event: sizes are clamped into a sane range. */
  routeResize(ev: { constructId: string; cols: number; rows: number }): Result<TerminalResize> {
    const terminalId = this.byConstruct.get(ev.constructId)
    if (!terminalId) return fail('not_bound', 'that pane is not bound to a terminal')
    if (!Number.isInteger(ev.cols) || !Number.isInteger(ev.rows)) return fail('invalid_input', 'cols and rows must be integers')
    return ok({ terminalId, cols: Math.min(MAX_COLS, Math.max(MIN_COLS, ev.cols)), rows: Math.min(MAX_ROWS, Math.max(MIN_ROWS, ev.rows)) })
  }
}
