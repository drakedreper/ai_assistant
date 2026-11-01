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
 *
 * Pairing. The session cookie is scoped to the HOST, not the port, so another local server the user browses to receives
 * it. Terminals therefore also need a second secret that is NOT a cookie: the daemon prints it in the FRAGMENT of its sign-in
 * link (`#tp=...`), which no server ever sees. This file takes it out of the address bar when the app loads, keeps it in
 * this origin's own storage (another port is another origin and cannot read it), and sends it as X-Terminal-Proof on every
 * terminal route. Without it the daemon answers 401 `terminal_proof_required` and the page says how to pair.
 *
 * What a program in the terminal may do to the page: nothing beyond drawing. No clipboard (OSC 52) and no link addon
 * are loaded, and the title sequences only change xterm's own state. Hyperlinks a program prints (OSC 8) are shown, but
 * activating one never opens it by itself: `createLinkHandler` below refuses everything but plain http and https
 * addresses and asks first, showing the real address, then opens it with noopener and noreferrer.
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

const PROOF_KEY = 'aia.terminalProof'
const PROOF_HEADER = 'X-Terminal-Proof'
let memoryProof: string | undefined

/** The terminal routes: the ones the daemon guards with the pairing proof. */
const isTerminalRoute = (path: string): boolean => path === DaemonRoutes.terminals || path.startsWith('/api/terminals/') || path === DaemonRoutes.terminalsEnabled

/**
 * Take the pairing proof (`#tp=...`) out of the address bar, keep it for this origin, and remove it from the URL (the
 * history entry too), so it never stays in the address bar, a bookmark or the history. Runs when this module loads.
 */
export function capturePairingProof(): void {
  if (typeof location === 'undefined' || typeof history === 'undefined') return
  try {
    const params = new URLSearchParams(location.hash.replace(/^#/, ''))
    const tp = params.get('tp')
    if (tp === null) return
    params.delete('tp')
    if (/^[A-Za-z0-9_-]{16,128}$/.test(tp)) {
      memoryProof = tp
      try {
        localStorage.setItem(PROOF_KEY, tp)
      } catch {
        /* storage blocked: the proof lives for this page only */
      }
    }
    const rest = params.toString()
    history.replaceState(history.state, '', `${location.pathname}${location.search}${rest ? `#${rest}` : ''}`)
  } catch {
    /* an odd URL must never break start-up */
  }
}
capturePairingProof()

function pairingProof(): string | undefined {
  if (memoryProof) return memoryProof
  try {
    return localStorage.getItem(PROOF_KEY) ?? undefined
  } catch {
    return undefined
  }
}

/** Has this browser been paired for terminals (does it hold a proof)? A stale one, from an earlier daemon run, still says true. */
export function hasPairingProof(): boolean {
  return pairingProof() !== undefined
}

async function call(method: string, path: string, body?: unknown): Promise<unknown> {
  const proof = isTerminalRoute(path) ? pairingProof() : undefined
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
      headers: {
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(proof !== undefined ? { [PROOF_HEADER]: proof } : {}),
      },
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
    // Before the generic 401: this one is not "signed out", it is "signed in but not paired for terminals".
    if (err.code === 'terminal_proof_required') return err.message || 'This browser is not paired with the daemon for terminals. Open the sign-in link the daemon printed when it started.'
    if (err.status === 401) return 'This browser is signed out of the daemon. Open the sign-in link it printed when it started.'
    return err.message
  }
  if (err instanceof Error && err.name === 'ZodError') return 'That request is not valid.'
  return err instanceof Error ? err.message.slice(0, 200) : 'Something went wrong.'
}

// ------------------------------------------------------------------------------------------------ links a program prints

/** The longest address that is offered at all. */
const MAX_LINK_CHARS = 2000

/**
 * The address behind a link a program printed, if it is one a person could safely be asked about: plain http or https, a
 * host, no embedded user name or password (`https://github.com@evil.example/`), no control, zero-width or bidirectional
 * characters (what you see must be what you get), not absurdly long. The returned `href` is the normalised form, so an
 * international host name is shown in its punycode spelling (a look-alike letter gives itself away).
 */
export function safeLinkTarget(raw: string): { href: string; host: string } | undefined {
  if (raw.length === 0 || raw.length > MAX_LINK_CHARS) return undefined
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/.test(raw)) return undefined
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return undefined
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return undefined
  if (u.hostname === '' || u.username !== '' || u.password !== '') return undefined
  return { href: u.href, host: u.host }
}

export interface LinkHandlerDeps {
  /** window.confirm: a native dialog the page cannot style, so a program cannot fake it. */
  confirm(message: string): boolean
  /** Opens the address in a new tab, with noopener and noreferrer. */
  open(href: string): void
  /** Shows the real address while the pointer is over a link (the title of the terminal frame), or clears it. */
  setTitle(text: string): void
  /** A link that was refused (for a short notice). */
  refused?(): void
}

/** xterm's ILinkHandler for OSC 8 hyperlinks: validate, show the real address on hover, ask before opening. */
export function createLinkHandler(deps: LinkHandlerDeps): { activate(event: MouseEvent, text: string): void; hover(event: MouseEvent, text: string): void; leave(): void } {
  return {
    activate(_event, text) {
      const target = safeLinkTarget(text)
      if (!target) return deps.refused?.()
      const ok = deps.confirm(`A program in this terminal printed a link.\n\nIt goes to ${target.host}\n${target.href}\n\nOpen it only if you expect it: the words you clicked may say something else, and this terminal runs commands as you.`)
      if (ok) deps.open(target.href)
    },
    hover(_event, text) {
      deps.setTitle(safeLinkTarget(text)?.href ?? '')
    },
    leave() {
      deps.setTitle('')
    },
  }
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
const CLOSE_RATE_LIMITED = 4429

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
    // OSC 8 links a program prints: validated, shown on hover, and only opened after a confirmation (see createLinkHandler).
    linkHandler: createLinkHandler({
      confirm: (m) => window.confirm(m),
      open: (href) => void window.open(href, '_blank', 'noopener,noreferrer'),
      setTitle: (t) => {
        opts.container.title = t
      },
      refused: () => opts.onNotice?.('A link in the terminal was not opened: only plain http and https addresses are offered.'),
    }),
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
  let resizeTimer: ReturnType<typeof setTimeout> | undefined
  const encoder = new TextEncoder()

  const report = (p: TerminalPhase, detail?: string, exitCode?: number | null): void => {
    opts.onState({ phase: p, ...(detail ? { detail } : {}), ...(exitCode !== undefined ? { exitCode } : {}) })
  }

  const sendResize = (): void => {
    if (!ws || ws.readyState !== WebSocket.OPEN || !live) return
    ws.send(JSON.stringify({ type: 'resize', cols: clamp(term.cols, MIN_COLS, MAX_COLS), rows: clamp(term.rows, MIN_ROWS, MAX_ROWS) }))
  }
  // Dragging a window edge changes the size dozens of times a second: only the size it settles on is sent (the daemon gives
  // text frames a small budget and closes a socket that floods them).
  const scheduleResize = (): void => {
    if (resizeTimer !== undefined) clearTimeout(resizeTimer)
    resizeTimer = setTimeout(() => {
      resizeTimer = undefined
      sendResize()
    }, 80)
  }

  const sendBytes = (bytes: Uint8Array): void => {
    if (!ws || ws.readyState !== WebSocket.OPEN || !live) return
    for (let off = 0; off < bytes.length; off += MAX_INPUT_FRAME) ws.send(bytes.subarray(off, Math.min(bytes.length, off + MAX_INPUT_FRAME)))
  }

  const dataSub = term.onData((d) => sendBytes(encoder.encode(d)))
  // Legacy mouse reports are raw bytes in a "binary string".
  const binSub = term.onBinary((d) => sendBytes(Uint8Array.from(d, (c) => c.charCodeAt(0) & 0xff)))
  const resizeSub = term.onResize(() => scheduleResize())

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
      if (ev.code === CLOSE_RATE_LIMITED) opts.onNotice?.('The terminal connection was closed for sending too many messages; reconnecting.')
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
      if (resizeTimer !== undefined) clearTimeout(resizeTimer)
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
