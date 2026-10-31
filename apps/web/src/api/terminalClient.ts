import {
  DaemonRoutes,
  OnOffRequest,
  TerminalCreateRequest,
  TerminalInfo,
  TerminalServerMessage,
  TerminalTicketResponse,
  type TerminalKind,
} from '@ai-assistant/shared'
import type { Terminal as XTerm } from '@xterm/xterm'
import type { FitAddon as XFitAddon } from '@xterm/addon-fit'

/**
 * Browser side of the embedded terminals (daemon mode only; see apps/daemon/README.md, "Terminal").
 *
 *  - REST: list, create, close, mint a ticket, and the Settings switch. Same origin, JSON, session cookie, exactly
 *    like daemonClient.ts. Nothing here ever puts a secret in a URL.
 *  - `attachTerminal`: opens xterm.js in a container and wires it to the daemon's WebSocket. For every connection it
 *    asks for a FRESH single-use ticket, opens the socket, and sends {type:'auth', ticket} as the first text frame.
 *    Keystrokes and output are BINARY frames; text frames are only the shared resize/ready/exit/error messages.
 *    If the socket drops (daemon restart, laptop sleep, a reload on the other side) it reconnects with a new ticket
 *    and the daemon replays the recent output; the process on the PC keeps running the whole time.
 *
 * xterm.js is imported lazily inside `attachTerminal`, so it is never part of the main bundle, and this file stays
 * small enough to import eagerly. Terminal bytes are never logged or stored by this code.
 */

export class TerminalApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'TerminalApiError'
  }
}

function errorFields(data: unknown): { code: string; message: string } {
  const o = data !== null && typeof data === 'object' ? (data as Record<string, unknown>) : {}
  return { code: typeof o.error === 'string' ? o.error : 'error', message: typeof o.message === 'string' ? o.message : '' }
}

async function call(method: string, path: string, body?: unknown): Promise<unknown> {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), 20_000)
  let res: Response
  let text: string
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      cache: 'no-store',
      signal: ctl.signal,
      headers: body === undefined ? { Accept: 'application/json' } : { Accept: 'application/json', 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    text = await res.text()
  } catch {
    throw new TerminalApiError(0, 'unreachable', 'The daemon is not reachable. Is it still running?')
  } finally {
    clearTimeout(timer)
  }
  let data: unknown
  try {
    data = text ? (JSON.parse(text) as unknown) : undefined
  } catch {
    data = undefined
  }
  if (res.status >= 200 && res.status < 300) return data
  const { code, message } = errorFields(data)
  throw new TerminalApiError(res.status, code, message || `The daemon answered HTTP ${res.status}.`)
}

export async function listTerminals(): Promise<TerminalInfo[]> {
  const data = await call('GET', DaemonRoutes.terminals)
  const parsed = TerminalInfo.array().safeParse(data)
  if (!parsed.success) throw new TerminalApiError(0, 'protocol', 'The daemon returned terminals this app does not understand. Rebuild the web app.')
  return parsed.data
}

export async function createTerminal(req: { kind: TerminalKind; projectId?: string; cwd?: string; cols?: number; rows?: number }): Promise<TerminalInfo> {
  const body = TerminalCreateRequest.parse(req)
  const data = await call('POST', DaemonRoutes.terminals, body)
  const parsed = TerminalInfo.safeParse(data)
  if (!parsed.success) throw new TerminalApiError(0, 'protocol', 'The daemon returned a terminal this app does not understand. Rebuild the web app.')
  return parsed.data
}

/** Kill the terminal's process tree and remove it (a terminal that already exited is just removed). */
export async function closeTerminal(id: string): Promise<void> {
  await call('DELETE', DaemonRoutes.terminal(id))
}

export async function requestTicket(id: string): Promise<string> {
  const data = await call('POST', DaemonRoutes.terminalTicket(id), {})
  const parsed = TerminalTicketResponse.safeParse(data)
  if (!parsed.success) throw new TerminalApiError(0, 'protocol', 'The daemon returned a ticket this app does not understand.')
  return parsed.data.ticket
}

/** The Settings switch. Turning it off kills every running terminal on the daemon. */
export async function setTerminalsEnabled(on: boolean): Promise<void> {
  await call('PUT', DaemonRoutes.terminalsEnabled, OnOffRequest.parse({ on }))
}

/** A message a person can read for a failed terminal call. */
export function describeTerminalError(err: unknown): string {
  if (err instanceof TerminalApiError) {
    if (err.code === 'claude_not_found') return err.message
    if (err.status === 401) return 'This browser is signed out of the daemon. Open the sign-in link it printed when it started.'
    return err.message
  }
  if (err instanceof Error && err.name === 'ZodError') return 'That request is not valid.'
  return err instanceof Error ? err.message.slice(0, 200) : 'Something went wrong.'
}

// ------------------------------------------------------------------------------------------------ the view

export type TerminalPhase = 'connecting' | 'live' | 'reconnecting' | 'exited' | 'gone' | 'disabled' | 'failed'

export interface TerminalViewState {
  phase: TerminalPhase
  /** Plain words for the status line (why it is reconnecting, what failed). */
  detail?: string
  exitCode?: number | null
}

export interface TerminalSession {
  focus(): void
  /** Move focus out of the terminal (Shift+Escape does this too: a terminal otherwise traps Tab). */
  blur(): void
  /** Try again now (after "failed", or to skip the backoff). */
  reconnect(): void
  setScreenReaderMode(on: boolean): void
  dispose(): void
}

export interface TerminalSessionOptions {
  container: HTMLElement
  terminalId: string
  /** Accessible name of the terminal. */
  label: string
  onState: (s: TerminalViewState) => void
  /** Short, non-sticky messages (input was throttled, ...). */
  onNotice?: (text: string) => void
  screenReaderMode?: boolean
}

/** What the xterm theme falls back to when the CSS tokens cannot be read. Matches src/styles.css. */
export const FALLBACK_MONO = '"Cascadia Code", "Cascadia Mono", "JetBrains Mono", Consolas, "Courier New", ui-monospace, monospace'

function token(name: string, fallback: string): string {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
    return v || fallback
  } catch {
    return fallback
  }
}

/** The terminal colours, from the app tokens. Every ANSI colour is readable on the dark canvas (and xterm lifts the rest to 4.5:1). */
export function terminalTheme(): NonNullable<XTerm['options']['theme']> {
  return {
    background: token('--color-canvas', '#0a0c16'),
    foreground: token('--color-fg', '#e9ebf7'),
    cursor: token('--color-mira', '#ff8fb1'),
    cursorAccent: token('--color-canvas', '#0a0c16'),
    selectionBackground: 'rgba(167, 139, 250, 0.38)',
    black: '#3b4170',
    red: token('--color-bad', '#f87171'),
    green: token('--color-ok', '#4ade80'),
    yellow: token('--color-warn', '#fbbf24'),
    blue: token('--color-world', '#60a5fa'),
    magenta: token('--color-brain', '#a78bfa'),
    cyan: token('--color-work', '#2dd4bf'),
    white: '#c9cde6',
    brightBlack: token('--color-faint', '#6c7499'),
    brightRed: '#fca5a5',
    brightGreen: '#86efac',
    brightYellow: '#fde68a',
    brightBlue: '#93c5fd',
    brightMagenta: '#c4b5fd',
    brightCyan: '#5eead4',
    brightWhite: token('--color-fg', '#f4f5fc'),
  }
}

const MAX_INPUT_FRAME = 8 * 1024
const MIN_COLS = 10
const MAX_COLS = 500
const MIN_ROWS = 5
const MAX_ROWS = 200
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(v)))

/** Close codes the daemon uses (apps/daemon/src/terminal/ws.ts). */
const CLOSE_UNAUTHORIZED = 4401
const CLOSE_AUTH_TIMEOUT = 4408
const CLOSE_ALREADY_ATTACHED = 4409

function wsUrl(id: string): string {
  const u = new URL(DaemonRoutes.terminalWs(id), location.href)
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:'
  return u.toString()
}

/**
 * Open xterm.js in `container` and connect it to terminal `terminalId`. Resolves once the xterm instance exists (the
 * connection continues in the background and reports through `onState`).
 */
export async function attachTerminal(opts: TerminalSessionOptions): Promise<TerminalSession> {
  const [{ Terminal }, { FitAddon }] = await Promise.all([import('@xterm/xterm'), import('@xterm/addon-fit')])

  const term: XTerm = new Terminal({
    fontFamily: token('--font-mono', FALLBACK_MONO) || FALLBACK_MONO,
    fontSize: 13,
    lineHeight: 1.15,
    cursorBlink: true,
    cursorStyle: 'bar',
    scrollback: 5000,
    allowProposedApi: false,
    minimumContrastRatio: 4.5,
    macOptionIsMeta: true,
    screenReaderMode: opts.screenReaderMode ?? false,
    theme: terminalTheme(),
  })
  const fit: XFitAddon = new FitAddon()
  term.loadAddon(fit)
  term.open(opts.container)
  term.textarea?.setAttribute('aria-label', `${opts.label}. This terminal runs commands as you. Press Shift+Escape to leave it.`)

  let disposed = false
  let ws: WebSocket | undefined
  let live = false
  let attempts = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let fitFrame = 0
  const encoder = new TextEncoder()

  const report = (p: TerminalPhase, detail?: string, exitCode?: number | null): void => {
    opts.onState({ phase: p, ...(detail ? { detail } : {}), ...(exitCode !== undefined ? { exitCode } : {}) })
  }

  const sendResize = (): void => {
    if (!ws || ws.readyState !== WebSocket.OPEN || !live) return
    ws.send(JSON.stringify({ type: 'resize', cols: clamp(term.cols, MIN_COLS, MAX_COLS), rows: clamp(term.rows, MIN_ROWS, MAX_ROWS) }))
  }

  const sendBytes = (bytes: Uint8Array): void => {
    if (!ws || ws.readyState !== WebSocket.OPEN || !live) return
    for (let off = 0; off < bytes.length; off += MAX_INPUT_FRAME) ws.send(bytes.subarray(off, Math.min(bytes.length, off + MAX_INPUT_FRAME)))
  }

  const dataSub = term.onData((d) => sendBytes(encoder.encode(d)))
  // Legacy mouse reports are raw bytes in a "binary string".
  const binSub = term.onBinary((d) => sendBytes(Uint8Array.from(d, (c) => c.charCodeAt(0) & 0xff)))
  const resizeSub = term.onResize(() => sendResize())

  term.attachCustomKeyEventHandler((e) => {
    if (e.type === 'keydown' && e.key === 'Escape' && e.shiftKey) {
      term.blur()
      return false
    }
    return true
  })

  const doFit = (): void => {
    cancelAnimationFrame(fitFrame)
    fitFrame = requestAnimationFrame(() => {
      if (disposed || opts.container.clientWidth < 40 || opts.container.clientHeight < 40) return
      try {
        fit.fit()
      } catch {
        /* the container is not laid out yet */
      }
    })
  }
  const observer = new ResizeObserver(doFit)
  observer.observe(opts.container)
  doFit()

  const onPageHide = (): void => {
    // Free the daemon's single client slot right away, so the reloaded page can attach without waiting for a timeout.
    try {
      ws?.close(1000, 'page closed')
    } catch {
      /* already closed */
    }
  }
  window.addEventListener('pagehide', onPageHide)

  const schedule = (ms: number): void => {
    if (timer !== undefined) clearTimeout(timer)
    timer = setTimeout(() => void connect(), ms)
  }
  const backoff = (): number => Math.min(8000, 500 * 2 ** Math.min(attempts, 4)) + Math.floor(Math.random() * 250)

  async function connect(): Promise<void> {
    if (disposed) return
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    live = false
    report(attempts === 0 ? 'connecting' : 'reconnecting', attempts === 0 ? undefined : 'Reconnecting to the terminal')
    let ticket: string
    try {
      ticket = await requestTicket(opts.terminalId)
    } catch (err) {
      if (disposed) return
      if (err instanceof TerminalApiError && err.status === 403) return report('disabled', 'Embedded terminals are switched off.')
      if (err instanceof TerminalApiError && err.status === 404) return report('gone', 'This terminal no longer exists.')
      if (err instanceof TerminalApiError && err.status === 401) return report('failed', describeTerminalError(err))
      attempts++
      report('reconnecting', 'The daemon is not reachable; retrying')
      return schedule(backoff())
    }
    if (disposed) return

    const sock = new WebSocket(wsUrl(opts.terminalId))
    sock.binaryType = 'arraybuffer'
    ws = sock
    let ready = false
    let finished = false

    sock.onopen = () => sock.send(JSON.stringify({ type: 'auth', ticket }))

    sock.onmessage = (ev: MessageEvent) => {
      if (disposed || ws !== sock) return
      if (typeof ev.data === 'string') {
        let msg: TerminalServerMessage
        try {
          msg = TerminalServerMessage.parse(JSON.parse(ev.data))
        } catch {
          return
        }
        if (msg.type === 'ready') {
          ready = true
          live = true
          attempts = 0
          // The scrollback follows as binary frames; start from a clean screen so a reconnect never duplicates it.
          term.reset()
          report('live')
          sendResize()
        } else if (msg.type === 'exit') {
          finished = true
          live = false
          term.write(`\r\n\x1b[2m[the process ended${msg.exitCode === null ? '' : ` with exit code ${msg.exitCode}`}]\x1b[0m\r\n`)
          report('exited', undefined, msg.exitCode)
        } else if (msg.type === 'error') {
          if (msg.message === 'input_rate_limited') opts.onNotice?.('That input was too fast and part of it was dropped.')
          else if (msg.message === 'already_attached') opts.onNotice?.('Another window is already connected to this terminal.')
        }
        return
      }
      if (ev.data instanceof ArrayBuffer) term.write(new Uint8Array(ev.data))
    }

    sock.onclose = (ev: CloseEvent) => {
      if (ws === sock) ws = undefined
      live = false
      if (disposed || finished) return
      if (ev.code === CLOSE_ALREADY_ATTACHED) {
        attempts++
        if (attempts > 6) return report('failed', 'Another window is connected to this terminal. Close it, then press Reconnect.')
        report('reconnecting', 'Another window is connected; waiting for it to let go')
        return schedule(1000 + attempts * 500)
      }
      if (ev.code === CLOSE_UNAUTHORIZED || ev.code === CLOSE_AUTH_TIMEOUT) {
        attempts++
        if (attempts > 4) return report('failed', 'The daemon refused the terminal connection. Reload the page and sign in again if needed.')
        report('reconnecting', 'Retrying with a new ticket')
        return schedule(300 * attempts)
      }
      attempts = ready ? 1 : attempts + 1
      report('reconnecting', 'The connection dropped; reconnecting')
      schedule(backoff())
    }
    sock.onerror = () => {
      /* onclose follows; nothing useful is exposed here */
    }
  }

  void connect()

  return {
    focus: () => term.focus(),
    blur: () => term.blur(),
    reconnect() {
      if (disposed) return
      attempts = 0
      try {
        ws?.close(1000, 'reconnect')
      } catch {
        /* already closed */
      }
      ws = undefined
      void connect()
    },
    setScreenReaderMode(on) {
      term.options.screenReaderMode = on
    },
    dispose() {
      if (disposed) return
      disposed = true
      if (timer !== undefined) clearTimeout(timer)
      cancelAnimationFrame(fitFrame)
      observer.disconnect()
      window.removeEventListener('pagehide', onPageHide)
      dataSub.dispose()
      binSub.dispose()
      resizeSub.dispose()
      try {
        ws?.close(1000, 'view closed')
      } catch {
        /* already closed */
      }
      ws = undefined
      term.dispose()
    },
  }
}
