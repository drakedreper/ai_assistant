import type { ApiClient, ConnectionState, ServerEvent, Snapshot, Unsubscribe } from '@ai-assistant/shared'
import { useSyncExternalStore } from 'react'
import {
  DaemonClient,
  DaemonHttpError,
  DaemonProtocolError,
  TERMINAL_ONLY_COPY,
  exchangeSignInCode,
  probeDaemon,
  stripCodeFromAddressBar,
  type DaemonNotice,
  type DaemonStatus,
} from './daemonClient'
import { FixtureClient } from './fixtureClient'

export { TERMINAL_ONLY_COPY }
export type { DaemonNotice }

/**
 * The one place the UI picks its backend. `import { api } from '../api'` keeps working everywhere: `api` is a
 * late-bound object that forwards to whichever client was chosen at start-up.
 *
 *   ?fixtures (or ?static)  the in-memory mockup, always. `?static` also freezes its live simulator.
 *   ?daemon                 the local daemon, no probing.
 *   ?code=...               the one-time sign-in link of the daemon: exchanged first, then removed from the URL.
 *   (nothing)               probe GET /api/health: a daemon answers, use it; anything else, use the mockup.
 *
 * Whatever is chosen, the UI is never left without data: if the daemon cannot be used (not signed in, refused,
 * unreachable, a different version) the mockup is shown and a notice says why, so nobody mistakes sample data for real
 * data. The mockup path never needs a daemon, so the single-file build keeps working from a file or any static host.
 */
export type ApiMode = 'daemon' | 'fixtures'

export interface ApiUi {
  /** False until the choice is made (the UI renders nothing before that). */
  selected: boolean
  mode: ApiMode
  /** Set when the mockup is showing although a daemon was expected: why. */
  fallbackNote: string | null
  /** Daemon mode: why the link is down right now, if known. */
  connectionNote: string | null
  /** Daemon mode: the Claude backend behind it ('fake' = scripted replies, zero tokens). */
  backend: 'fake' | 'sdk' | null
  /** Recent command failures, newest last. They expire on their own. */
  notices: DaemonNotice[]
}

let ui: ApiUi = { selected: false, mode: 'fixtures', fallbackNote: null, connectionNote: null, backend: null, notices: [] }
const listeners = new Set<() => void>()

function setUi(patch: Partial<ApiUi>): void {
  ui = { ...ui, ...patch }
  for (const l of [...listeners]) l()
}

function subscribeUi(l: () => void): () => void {
  listeners.add(l)
  return () => listeners.delete(l)
}

/** Everything the connection banner and the Live/Mockup badge need. */
export function useApiUi(): ApiUi {
  return useSyncExternalStore(subscribeUi, () => ui)
}

export function useApiMode(): ApiMode {
  return useSyncExternalStore(subscribeUi, () => ui.mode)
}

/** Non-hook access (event handlers, scripts). */
export function apiMode(): ApiMode {
  return ui.mode
}

const NOTICE_TTL_MS = 9000

export function dismissNotice(id: number): void {
  setUi({ notices: ui.notices.filter((n) => n.id !== id) })
}

function pushNotice(n: DaemonNotice): void {
  // The same message twice in a row (a button hammered while offline) is one notice, not a stack.
  const last = ui.notices[ui.notices.length - 1]
  if (last && last.text === n.text) return
  setUi({ notices: [...ui.notices, n].slice(-3) })
  setTimeout(() => dismissNotice(n.id), NOTICE_TTL_MS)
}

// ------------------------------------------------------------------------------------------------ selection

const FALLBACK_SIGN_IN =
  'A Mira daemon is running here, but this browser is not signed in, so you are looking at the mockup (sample data). Open the sign-in link the daemon printed when it started, or restart the daemon for a new one.'
const FALLBACK_REFUSED =
  'A Mira daemon answered but refused this address, so you are looking at the mockup (sample data). Open it exactly as printed (http://127.0.0.1:PORT), or through the Vite dev server.'
const FALLBACK_UNREACHABLE = 'Could not reach the daemon at this address, so you are looking at the mockup (sample data).'

let backend: ApiClient | undefined
/** The snapshot fetched while verifying the daemon, handed to the first getSnapshot() instead of fetching twice. */
let prefetched: Snapshot | undefined

function adoptFixtures(simulate: boolean, note: string | null): void {
  backend = new FixtureClient({ simulate })
  setUi({ selected: true, mode: 'fixtures', fallbackNote: note })
}

function why(err: unknown, exchangeNote: string | null): string {
  if (err instanceof DaemonHttpError && err.status === 401) return exchangeNote ? `${exchangeNote} You are looking at the mockup (sample data).` : FALLBACK_SIGN_IN
  if (err instanceof DaemonHttpError && err.status === 403) return FALLBACK_REFUSED
  if (err instanceof DaemonProtocolError) return `${err.message} Showing the mockup (sample data) instead.`
  return exchangeNote ? `${exchangeNote} ${FALLBACK_UNREACHABLE}` : FALLBACK_UNREACHABLE
}

async function select(): Promise<void> {
  try {
    const loc = typeof location === 'undefined' ? undefined : location
    const params = new URLSearchParams(loc?.search ?? '')
    // Existing behaviour: `?static` freezes the simulator (screenshots, the smoke test). No browser: frozen too.
    const simulate = loc !== undefined && !params.has('static')

    if (!loc || params.has('fixtures') || params.has('static') || !/^https?:$/.test(loc.protocol)) {
      // The mockup has no use for a sign-in code, but a credential still does not stay in the address bar.
      stripCodeFromAddressBar()
      adoptFixtures(simulate, null)
      return
    }

    const hasCode = params.has('code')
    let exchangeNote: string | null = null
    if (hasCode) {
      const ex = await exchangeSignInCode()
      if (ex.kind === 'failed') exchangeNote = ex.message
    }

    if (!params.has('daemon') && !hasCode) {
      const probe = await probeDaemon({ timeoutMs: 1500 })
      if (probe.kind === 'none') return adoptFixtures(simulate, null)
      if (probe.kind === 'signin_required') return adoptFixtures(simulate, FALLBACK_SIGN_IN)
      if (probe.kind === 'refused') return adoptFixtures(simulate, FALLBACK_REFUSED)
    }

    const client = new DaemonClient()
    try {
      // The first snapshot is the real test that the daemon is usable (signed in, same version).
      prefetched = await client.getSnapshot()
    } catch (err) {
      client.dispose()
      adoptFixtures(simulate, why(err, exchangeNote))
      return
    }
    client.onStatus((s: DaemonStatus) => setUi({ connectionNote: s.note, backend: s.backend }))
    client.onNotice(pushNotice)
    backend = client
    setUi({ selected: true, mode: 'daemon', fallbackNote: null })
  } catch {
    // Selection must never reject: the app has to come up with something honest.
    adoptFixtures(false, FALLBACK_UNREACHABLE)
  }
}

/** Resolves once the backend is chosen (and, for the daemon, verified). store.init awaits it. */
export const apiReady: Promise<void> = select()

// ------------------------------------------------------------------------------------------------ the delegating api

async function late<T>(use: (b: ApiClient) => Promise<T>): Promise<T> {
  await apiReady
  return use(backend as ApiClient)
}

/** subscribe/onConnection must return an unsubscribe synchronously, but the backend may not be chosen yet. */
function lateSubscription(attach: (b: ApiClient) => Unsubscribe): Unsubscribe {
  let off: Unsubscribe | undefined
  let cancelled = false
  void apiReady.then(() => {
    if (!cancelled) off = attach(backend as ApiClient)
  })
  return () => {
    cancelled = true
    off?.()
  }
}

export const api: ApiClient = {
  async getSnapshot() {
    await apiReady
    if (prefetched) {
      const first = prefetched
      prefetched = undefined
      return first
    }
    return (backend as ApiClient).getSnapshot()
  },
  subscribe: (handler: (e: ServerEvent) => void) => lateSubscription((b) => b.subscribe(handler)),
  onConnection: (handler: (s: ConnectionState) => void) => lateSubscription((b) => b.onConnection?.(handler) ?? (() => undefined)),

  sendChat: (text, modality) => late((b) => b.sendChat(text, modality)),
  interruptChat: () => late((b) => b.interruptChat()),
  decideApproval: (id, decision) => late((b) => b.decideApproval(id, decision)),
  decideProposal: (id, decision) => late((b) => b.decideProposal(id, decision)),
  moveTask: (id, column) => late((b) => b.moveTask(id, column)),
  createTask: (input) => late((b) => b.createTask(input)),
  setTrustMode: (ruleId, mode) => late((b) => b.setTrustMode(ruleId, mode)),
  setClaudeMode: (mode) => late((b) => b.setClaudeMode(mode)),
  setGuestMode: (on) => late((b) => b.setGuestMode(on)),
  setWebcam: (on) => late((b) => b.setWebcam(on)),
  updatePersona: (patch) => late((b) => b.updatePersona(patch)),
  forgetFact: (id) => late((b) => b.forgetFact(id)),
}
