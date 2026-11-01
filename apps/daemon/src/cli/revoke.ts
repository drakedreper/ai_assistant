import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { ConfigError, loadConfig } from '../config'
import { createIdGen } from '../ids'
import { readSecretsFile, writeSecretsFile } from '../security'
import { openStore, type Store } from '../store'

/**
 * `tsx src/cli/revoke.ts [--dry-run]`: sign EVERY browser out. It empties the list of browser sessions in
 * DATA_DIR/secrets.json (the hook and stage tokens are not touched: `hooks token --rotate` and `stage token --rotate` do
 * those) and writes an audit entry. It is the way to cut off a session cookie that leaked (it is valid for 30 days
 * otherwise) without reaching the app, for instance when the cookie is the one that is no longer yours.
 *
 * A running daemon notices the changed file on its next request and closes the live connections of the revoked sessions
 * (the dashboards' feed and terminal viewers; the terminals' processes keep running) within seconds. To sign in again,
 * restart the daemon: the one-time sign-in link is printed only at start. The command never prints a token or a hash.
 *
 * "Sign out of this browser" and "sign out everywhere" without the command line are POST /api/auth/signout.
 */

export interface RevokeIo {
  out(text: string): void
  err(text: string): void
  now(): Date
  platform: NodeJS.Platform
  homedir: string
}

export interface RevokeDeps {
  /** Open the operations database (to audit); tests pass their own. */
  openStore?: (file: string) => Store
}

const HELP = `Usage: pnpm --filter @ai-assistant/daemon exec tsx src/cli/revoke.ts [--dry-run]

Signs every browser out of the daemon (it needs the sign-in link of a restart afterwards).

Options
  --dry-run   Only say how many browser sessions exist. Changes nothing.
  --help      This text.
`

/** Entry point, injectable for tests. Returns the process exit code. */
export function runRevokeCli(argv: string[], env: NodeJS.ProcessEnv, io: RevokeIo, deps: RevokeDeps = {}): number {
  let values: { 'dry-run'?: boolean; help?: boolean }
  let positionals: string[]
  try {
    const parsed = parseArgs({ args: argv, allowPositionals: true, options: { 'dry-run': { type: 'boolean' }, help: { type: 'boolean', short: 'h' } } })
    values = parsed.values
    positionals = parsed.positionals
  } catch (err) {
    io.err(`${err instanceof Error ? err.message : 'bad arguments'}\n\n${HELP}`)
    return 2
  }
  if (values.help) {
    io.out(HELP)
    return 0
  }
  if (positionals.length > 0) {
    io.err(`Unexpected argument "${positionals.join(' ')}"\n\n${HELP}`)
    return 2
  }

  let config
  try {
    config = loadConfig(env, { platform: io.platform, homedir: io.homedir })
  } catch (err) {
    io.err(`Configuration error: ${err instanceof ConfigError ? err.message : 'invalid environment'}\n`)
    return 2
  }
  const secrets = readSecretsFile(config.dataDir)
  if (!secrets) {
    io.err(`There is no secrets.json in ${config.dataDir}, so there is no browser session to revoke. (Wrong DATA_DIR? Has the daemon never run?)\n`)
    return 1
  }
  const count = secrets.sessions.length
  if (values['dry-run']) {
    io.out(`${count} browser session(s) would be revoked. Nothing was changed.\n`)
    return 0
  }
  writeSecretsFile(config.dataDir, { ...secrets, sessions: [] })

  // The audit trail: the same table the app shows in Settings. A database that is missing, busy or newer than this build
  // does not undo the revocation; it only means there is no entry, and the command says so.
  let audited = false
  if (existsSync(config.dbFile)) {
    let store: Store | undefined
    try {
      store = (deps.openStore ?? ((file) => openStore({ file })))(config.dbFile)
      store.insertAudit({
        id: createIdGen(() => io.now().getTime())('au'),
        at: io.now().toISOString(),
        actor: 'you',
        action: 'Revoked every browser session (command line)',
        target: 'Local daemon',
        outcome: 'auto',
        detail: `${count} session(s)`,
      })
      audited = true
    } catch {
      /* reported below */
    } finally {
      try {
        store?.close()
      } catch {
        /* closed */
      }
    }
  }
  io.out(`Revoked ${count} browser session(s).${audited ? ' Audited.' : ''}\n`)
  if (!audited) io.err('No audit entry could be written (no database yet, or it is busy). The sessions are revoked all the same.\n')
  io.out('A running daemon closes their live connections within seconds. Restart the daemon to get a fresh sign-in link.\n')
  return 0
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) {
  process.exit(
    runRevokeCli(process.argv.slice(2), process.env, {
      out: (t) => void process.stdout.write(t),
      err: (t) => void process.stderr.write(t),
      now: () => new Date(),
      platform: process.platform,
      homedir: homedir(),
    }),
  )
}
