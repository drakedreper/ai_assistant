export interface BannerInfo {
  version: string
  port: number
  exchangeUrl: string
  exchangeTtlMinutes: number
  dataDir: string
  backend: 'fake' | 'sdk'
  authMode: 'api-key' | 'local-login'
  apiKeyPresent: boolean
  demo: boolean
  webBuilt: boolean
  /** Additive: the daemon runs in the Docker image (MIRA_CONTAINER=1). */
  containerMode?: boolean
  /** Additive: this really looks like a container (/.dockerenv or /run/.containerenv). Only used to warn. */
  containerDetected?: boolean
}

/**
 * The startup banner. It prints the one-time sign-in link (that is its job) but never an API key or the hook token.
 */
export function formatBanner(i: BannerInfo): string[] {
  const lines: string[] = []
  if (i.containerMode) {
    lines.push('', `Mira daemon ${i.version}`, `  Listening   http://127.0.0.1:${i.port}  (container mode: the daemon listens on every interface INSIDE the container)`)
    lines.push('              Publish the port on 127.0.0.1 only (docker-compose.yml does: "127.0.0.1:PORT:PORT"). Never -p PORT:PORT.')
    if (i.containerDetected === false) {
      lines.push('              WARNING: MIRA_CONTAINER=1 but this does not look like a container: the daemon is reachable from your network.')
    }
  } else {
    lines.push('', `Mira daemon ${i.version}`, `  Listening   http://127.0.0.1:${i.port}  (loopback only)`)
  }
  lines.push(`  Sign in     ${i.exchangeUrl}`, `              open this once; it works for ${i.exchangeTtlMinutes} minutes and only one time`)
  lines.push(`  Data dir    ${i.dataDir}`)
  if (i.backend === 'fake') {
    lines.push(
      '  Backend     FAKE: scripted replies, zero tokens, no network. Nothing here talks to Claude.',
      '              Set CLAUDE_BACKEND=sdk (and ANTHROPIC_API_KEY) for the real thing.',
    )
  } else {
    lines.push(`  Backend     sdk (auth mode: ${i.authMode}${i.authMode === 'api-key' ? `, API key ${i.apiKeyPresent ? 'set' : 'NOT SET'}` : ''})`)
    if (i.authMode === 'api-key' && !i.apiKeyPresent) lines.push('              WARNING: ANTHROPIC_API_KEY is not set, the chat lane will fail to start.')
  }
  if (i.demo) lines.push('  Demo mode   fixture sessions, tasks and approvals are loaded (demo.db, disposable)')
  if (!i.webBuilt) lines.push('  Web UI      not built (pnpm --filter @ai-assistant/web build), or use the Vite dev server')
  lines.push('')
  return lines
}
