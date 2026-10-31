import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import * as nodePath from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { ConfigError, loadConfig } from '../config'
import { readSecretsFile, rotateSecretsHookToken } from '../security'
import {
  buildHooksBlock,
  eventsFor,
  lineDiff,
  mergeHooks,
  removeHooks,
  SettingsShapeError,
  TOKEN_ENV_VAR,
  type BuildOptions,
  type Change,
} from './hookSettings'

export interface CliIo {
  out(text: string): void
  err(text: string): void
  now(): Date
  platform: NodeJS.Platform
  homedir: string
}

const HELP = `Usage: pnpm --filter @ai-assistant/daemon hooks <command> [options]

Commands
  print       (default) Print the "hooks" block for Claude Code settings.json. Writes nothing.
  install     Show the change to settings.json. With --apply: back it up and merge our hooks in.
  uninstall   Show what would be removed. With --apply: remove only the entries pointing at our URL.
  token       Print the hook token (read from secrets.json). With --rotate: create a new one.

Options
  --apply            Actually write settings.json (install, uninstall).
  --embed-token      Put the literal token in the Authorization header instead of $${TOKEN_ENV_VAR}.
  --port <n>         Daemon port (default: DAEMON_PORT or 7421).
  --skip <Event>     Leave an event out (repeatable), for example --skip PermissionRequest.
  --config-dir <d>   Claude config directory (default: CLAUDE_CONFIG_DIR or ~/.claude).
  --settings <file>  Use this settings file instead of <config-dir>/settings.json.
  --rotate           With "token": generate a new hook token (update installed hooks afterwards).
`

/** The Claude Code config directory: CLAUDE_CONFIG_DIR, else <home>/.claude. Windows aware. */
export function resolveClaudeDir(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, home: string): string {
  const p = platform === 'win32' ? nodePath.win32 : nodePath.posix
  const override = env.CLAUDE_CONFIG_DIR?.trim()
  return override ? p.resolve(override) : p.join(home, '.claude')
}

/** UTC timestamp without colons, safe in a Windows file name. */
export function backupStamp(d: Date): string {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '')
}

interface ParsedSettings {
  value: unknown
  raw: string
  eol: '\n' | '\r\n'
  indent: string | number
  existed: boolean
}

function readSettings(file: string): ParsedSettings {
  if (!existsSync(file)) return { value: {}, raw: '', eol: '\n', indent: 2, existed: false }
  const raw = readFileSync(file, 'utf8').replace(/^﻿/, '')
  const eol = raw.includes('\r\n') ? '\r\n' : '\n'
  const indentMatch = /^([ \t]+)"/m.exec(raw)
  const indent: string | number = indentMatch?.[1] ?? 2
  if (raw.trim() === '') return { value: {}, raw, eol, indent, existed: true }
  try {
    return { value: JSON.parse(raw), raw, eol, indent, existed: true }
  } catch (err) {
    throw new SettingsShapeError(`${file} is not valid JSON (${err instanceof Error ? err.message : 'parse error'}). Nothing was changed.`)
  }
}

function serialize(value: unknown, p: ParsedSettings): string {
  return `${JSON.stringify(value, null, p.indent).replace(/\n/g, p.eol)}${p.eol}`
}

function writeAtomic(file: string, text: string): void {
  mkdirSync(nodePath.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}`
  writeFileSync(tmp, text, 'utf8')
  renameSync(tmp, file)
}

function summarize(changes: Change[]): string {
  if (changes.length === 0) return '  (no entries of ours found)'
  return changes.map((c) => `  ${c.kind.padEnd(9)} ${c.event}`).join('\n')
}

/** Entry point, injectable for tests. Returns the process exit code. */
export function runHooksCli(argv: string[], env: NodeJS.ProcessEnv, io: CliIo): number {
  let values: { apply?: boolean; 'embed-token'?: boolean; port?: string; skip?: string[]; 'config-dir'?: string; settings?: string; rotate?: boolean; help?: boolean }
  let positionals: string[]
  try {
    const parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        apply: { type: 'boolean' },
        'embed-token': { type: 'boolean' },
        port: { type: 'string' },
        skip: { type: 'string', multiple: true },
        'config-dir': { type: 'string' },
        settings: { type: 'string' },
        rotate: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    })
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
  const command = positionals[0] ?? 'print'
  if (!['print', 'install', 'uninstall', 'token'].includes(command) || positionals.length > 1) {
    io.err(`Unknown command "${positionals.join(' ')}"\n\n${HELP}`)
    return 2
  }

  let config
  try {
    config = loadConfig(env, { platform: io.platform, homedir: io.homedir })
  } catch (err) {
    io.err(`Configuration error: ${err instanceof ConfigError ? err.message : 'invalid environment'}\n`)
    return 2
  }
  const port = values.port !== undefined ? Number(values.port) : config.port
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    io.err('--port must be an integer between 1 and 65535\n')
    return 2
  }
  const skip = values.skip ?? []

  if (command === 'token') {
    if (values.rotate) {
      const t = rotateSecretsHookToken(config.dataDir)
      if (!t) {
        io.err('No secrets.json yet. Start the daemon once so it can create one.\n')
        return 1
      }
      io.out(`${t}\n`)
      io.err('Token rotated. A running daemon picks it up automatically. Update the environment variable or re-run install --embed-token --apply.\n')
      return 0
    }
    const secrets = readSecretsFile(config.dataDir)
    if (!secrets) {
      io.err('No hook token yet. Start the daemon once (pnpm --filter @ai-assistant/daemon start) so it can create secrets.json.\n')
      return 1
    }
    io.out(`${secrets.hookToken}\n`)
    return 0
  }

  const build: BuildOptions = { port, skip }
  if (values['embed-token']) {
    const secrets = readSecretsFile(config.dataDir)
    if (!secrets) {
      io.err('--embed-token needs an existing hook token. Start the daemon once so it can create secrets.json, then retry.\n')
      return 1
    }
    build.embedToken = secrets.hookToken
  }

  if (command === 'print') {
    io.out(`${JSON.stringify({ hooks: buildHooksBlock(build) }, null, 2)}\n`)
    io.err(
      [
        '',
        `Merge this "hooks" object into your Claude Code settings.json (or let "install --apply" do it safely).`,
        build.embedToken === undefined
          ? `The Authorization header reads the token from $${TOKEN_ENV_VAR}. Set that variable in the environment of every shell that starts claude:\n  Windows (persistent): setx ${TOKEN_ENV_VAR} <token>   then open a new terminal\n  PowerShell (session): $env:${TOKEN_ENV_VAR} = '<token>'\n  Get the token with: pnpm --filter @ai-assistant/daemon hooks token`
          : 'The literal hook token is in the output above: treat that settings.json like a secret.',
        'Field names (type "http", url, timeout, headers, allowedEnvVars, onFailure) follow the research notes, not a live read of the Claude Code hooks reference. If Claude Code complains, check https://code.claude.com/docs/en/hooks.',
        'PreToolUse is deliberately not hooked: a slow receiver there would block tools. Hooks are fail-open (onFailure "continue").',
        '',
      ].join('\n'),
    )
    return 0
  }

  // install / uninstall
  const claudeDir = values['config-dir'] ? nodePath.resolve(values['config-dir']) : resolveClaudeDir(env, io.platform, io.homedir)
  const file = values.settings ? nodePath.resolve(values.settings) : nodePath.join(claudeDir, 'settings.json')
  let current: ParsedSettings
  let result: { settings: Record<string, unknown>; changes: Change[] }
  try {
    current = readSettings(file)
    result = command === 'install' ? mergeHooks(current.value, build) : removeHooks(current.value, port)
  } catch (err) {
    if (err instanceof SettingsShapeError) {
      io.err(`${err.message}\n`)
      return 1
    }
    throw err
  }

  const before = current.existed && current.raw.trim() !== '' ? current.raw.replace(/\r\n/g, '\n').replace(/\n$/, '') : '{}'
  const afterText = serialize(result.settings, current)
  const diff = lineDiff(before, afterText.replace(/\r\n/g, '\n').replace(/\n$/, ''))
  const touched = result.changes.filter((c) => c.kind !== 'unchanged')

  io.out(`${command === 'install' ? 'Install' : 'Uninstall'} hooks in ${file}\n${summarize(result.changes)}\n`)
  if (command === 'install') io.out(`Events: ${eventsFor(build).join(', ')}\n`)
  if (diff) io.out(`\nDiff:\n${diff}\n`)

  if (!values.apply) {
    io.out(`\nDry run: nothing was written. Re-run with --apply to ${command}.\n`)
    return 0
  }
  if (touched.length === 0) {
    io.out('\nNothing to change.\n')
    return 0
  }
  if (current.existed) {
    const backup = `${file}.bak-${backupStamp(io.now())}`
    copyFileSync(file, backup)
    io.out(`\nBacked up the existing file to ${backup}\n`)
  }
  writeAtomic(file, afterText)
  io.out(`Wrote ${file}\n`)
  if (command === 'install' && build.embedToken === undefined) {
    io.out(`Remember to set ${TOKEN_ENV_VAR} (see "hooks print"), otherwise the hooks are rejected and Claude Code simply continues without them.\n`)
  }
  return 0
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) {
  const code = runHooksCli(process.argv.slice(2), process.env, {
    out: (t) => void process.stdout.write(t),
    err: (t) => void process.stderr.write(t),
    now: () => new Date(),
    platform: process.platform,
    homedir: homedir(),
  })
  process.exit(code)
}
