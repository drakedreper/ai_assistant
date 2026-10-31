import type { ApiClient } from '@ai-assistant/shared'
import { FixtureClient } from './fixtureClient'

/**
 * The one place the UI picks its backend. Phase 1 swaps this for a WebSocket+REST client that talks to
 * the local daemon; nothing else in the UI changes.  `?static` freezes the mockup (used for screenshots).
 */
export const api: ApiClient = new FixtureClient({
  simulate: typeof location === 'undefined' ? false : !new URLSearchParams(location.search).has('static'),
})
