import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { NON_BLOCKING_HOOK_EVENTS } from '@ai-assistant/shared'
import { backupStamp, resolveClaudeDir, runHooksCli, type CliIo } from '../src/cli/hooks'
import {
  buildHandler,
  buildHooksBlock,
  hookUrl,
  isOurHandler,
  lineDiff,
  mergeHooks,
  removeHooks,
  SettingsShapeError,
  TOKEN_ENV_VAR,
} from '../src/cli/hookSettings'
import { loadOrCreateSecrets, readSecretsFile } from '../src/security'
import { makeTmp } from './helpers'

const tmps: Array<() => void> = []
afterEach(() => {
  for (const c of tmps.splice(0)) c()
})

interface Run {
  code: number
  out: string
  err: string
}

function setup() {
  const t = makeTmp('cli-test-')
  tmps.push(t.cleanup)
  const claudeDir = join(t.dir, 'claude')
  const dataDir = join(t.dir, 'data')
  const settings = join(claudeDir, 'settings.json')
  const env: NodeJS.ProcessEnv = { CLAUDE_CONFIG_DIR: claudeDir, DATA_DIR: dataDir }
  const run = (args: string[], over: NodeJS.ProcessEnv = {}): Run => {
    let out = ''
    let err = ''
    const io: CliIo = {
      out: (s) => void (out += s),
      err: (s) => void (err += s),
      now: () => new Date('2026-11-02T10:11:12.345Z'),
      platform: 'linux',
      homedir: '/home/nobody',
    }
    const code = runHooksCli(args, { ...env, ...over }, io)
    return { code, out, err }
  }
  return { ...t, claudeDir, dataDir, settings, env, run }
}

const PORT = 7421
const ours = (settings: Record<string, unknown>, event: string, port = PORT): unknown[] => {
  const groups = ((settings.hooks as Record<string, unknown[]> | undefined)?.[event] ?? []) as Array<{ hooks: unknown[] }>
  return groups.flatMap((g) => g.hooks).filter((h) => isOurHandler(h, event, port))
}
const readJson = (file: string) => JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>

const USER_SETTINGS = {
  model: 'opus',
  permissions: { allow: ['Bash(git status)'] },
  hooks: {
    PostToolUse: [{ matcher: 'Write|Edit', hooks: [{ type: 'command', command: 'prettier --write' }] }],
    Notification: [{ hooks: [{ type: 'command', command: 'notify-send claude' }] }],
    PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'audit.sh' }] }],
  },
}

describe('hooks print', () => {
  it('prints the hooks block for exactly the non-blocking events and writes nothing', () => {
    const s = setup()
    const r = s.run([])
    expect(r.code).toBe(0)
    const printed = JSON.parse(r.out) as { hooks: Record<string, Array<{ hooks: Array<Record<string, unknown>> }>> }
    expect(Object.keys(printed.hooks)).toEqual([...NON_BLOCKING_HOOK_EVENTS])
    expect(printed.hooks.PreToolUse).toBeUndefined()
    for (const event of NON_BLOCKING_HOOK_EVENTS) {
      const groups = printed.hooks[event]!
      expect(groups).toHaveLength(1)
      expect(groups[0]!.hooks).toHaveLength(1)
      const h = groups[0]!.hooks[0]!
      expect(h).toMatchObject({
        type: 'http',
        url: `http://127.0.0.1:${PORT}/hooks/${event}`,
        onFailure: 'continue',
        headers: { Authorization: `Bearer $${TOKEN_ENV_VAR}` },
        allowedEnvVars: [TOKEN_ENV_VAR],
      })
      expect(h.timeout).toBe(event === 'SessionEnd' ? 1 : 2)
    }
    // No side effects at all: no settings file, no secrets file, no data dir.
    expect(existsSync(s.settings)).toBe(false)
    expect(existsSync(s.claudeDir)).toBe(false)
    expect(existsSync(s.dataDir)).toBe(false)
    expect(r.err).toContain('PreToolUse is deliberately not hooked')
    expect(r.err).toContain('not a live read')
    expect(r.out).not.toMatch(/sk-ant|secret/i)
  })

  it('"print" is the default command and takes --port and --skip', () => {
    const s = setup()
    const r = s.run(['print', '--port', '9000', '--skip', 'PermissionRequest', '--skip=SessionEnd'])
    const printed = JSON.parse(r.out) as { hooks: Record<string, unknown> }
    expect(Object.keys(printed.hooks)).not.toContain('PermissionRequest')
    expect(Object.keys(printed.hooks)).not.toContain('SessionEnd')
    expect(JSON.stringify(printed)).toContain('http://127.0.0.1:9000/hooks/Stop')
    expect(s.run([], { DAEMON_PORT: '8123' }).out).toContain('http://127.0.0.1:8123/hooks/Stop')
  })

  it('--embed-token needs an existing token (it never creates one) and then writes it literally', () => {
    const s = setup()
    const r = s.run(['print', '--embed-token'])
    expect(r.code).toBe(1)
    expect(existsSync(s.dataDir)).toBe(false)
    const secrets = loadOrCreateSecrets(s.dataDir)
    const ok = s.run(['print', '--embed-token'])
    expect(ok.code).toBe(0)
    const handler = (JSON.parse(ok.out) as { hooks: Record<string, Array<{ hooks: Array<Record<string, unknown>> }>> }).hooks.Stop![0]!.hooks[0]!
    expect(handler.headers).toEqual({ Authorization: `Bearer ${secrets.hookToken}` })
    expect(handler.allowedEnvVars).toBeUndefined()
    expect(ok.err).toContain('treat that settings.json like a secret')
  })

  it('rejects bad arguments with exit code 2 and shows help', () => {
    const s = setup()
    expect(s.run(['frobnicate']).code).toBe(2)
    expect(s.run(['print', 'extra']).code).toBe(2)
    expect(s.run(['--nope']).code).toBe(2)
    expect(s.run(['print', '--port', 'abc']).code).toBe(2)
    expect(s.run(['print', '--port', '99999']).code).toBe(2)
    expect(s.run(['print'], { DAEMON_PORT: 'abc' }).code).toBe(2)
    const help = s.run(['--help'])
    expect(help.code).toBe(0)
    expect(help.out).toContain('Usage:')
  })
})

describe('hooks install', () => {
  it('without --apply only shows the diff and writes nothing', () => {
    const s = setup()
    mkdirSync(s.claudeDir, { recursive: true })
    writeFileSync(s.settings, JSON.stringify(USER_SETTINGS, null, 2))
    const before = readFileSync(s.settings, 'utf8')
    const r = s.run(['install'])
    expect(r.code).toBe(0)
    expect(r.out).toContain('Dry run: nothing was written')
    expect(r.out).toContain('added     SessionStart')
    expect(r.out).toContain('+ ')
    expect(readFileSync(s.settings, 'utf8')).toBe(before)
    expect(readdirSync(s.claudeDir)).toEqual(['settings.json'])
  })

  it('--apply creates the file when there is none (no backup needed) and registers every event', () => {
    const s = setup()
    const r = s.run(['install', '--apply'])
    expect(r.code).toBe(0)
    const written = readJson(s.settings)
    for (const event of NON_BLOCKING_HOOK_EVENTS) expect(ours(written, event)).toHaveLength(1)
    expect(readdirSync(s.claudeDir)).toEqual(['settings.json'])
    expect(r.out).toContain(`set ${TOKEN_ENV_VAR}`)
  })

  it('--apply backs up the existing file with a timestamp and keeps every other setting and hook', () => {
    const s = setup()
    mkdirSync(s.claudeDir, { recursive: true })
    const original = JSON.stringify(USER_SETTINGS, null, 2)
    writeFileSync(s.settings, original)
    const r = s.run(['install', '--apply'])
    expect(r.code).toBe(0)

    const files = readdirSync(s.claudeDir).sort()
    expect(files).toEqual(['settings.json', 'settings.json.bak-20261102T101112'])
    expect(readFileSync(join(s.claudeDir, files[1]!), 'utf8')).toBe(original)

    const after = readJson(s.settings)
    expect(after.model).toBe('opus')
    expect(after.permissions).toEqual(USER_SETTINGS.permissions)
    const hooks = after.hooks as Record<string, Array<{ matcher?: string; hooks: Array<Record<string, unknown>> }>>
    // The user's own hooks are intact, including the one on an event we do not touch.
    expect(hooks.PostToolUse![0]).toEqual(USER_SETTINGS.hooks.PostToolUse[0])
    expect(hooks.Notification![0]).toEqual(USER_SETTINGS.hooks.Notification[0])
    expect(hooks.PreToolUse).toEqual(USER_SETTINGS.hooks.PreToolUse)
    // Ours are added next to them, as separate groups.
    expect(hooks.PostToolUse).toHaveLength(2)
    expect(hooks.Notification).toHaveLength(2)
    expect(ours(after, 'PostToolUse')).toHaveLength(1)
    expect(ours(after, 'Stop')).toHaveLength(1)
  })

  it('is idempotent: a second --apply changes nothing, creates no backup and never duplicates', () => {
    const s = setup()
    mkdirSync(s.claudeDir, { recursive: true })
    writeFileSync(s.settings, JSON.stringify(USER_SETTINGS, null, 2))
    s.run(['install', '--apply'])
    const once = readFileSync(s.settings, 'utf8')
    const filesOnce = readdirSync(s.claudeDir).sort()
    const second = s.run(['install', '--apply'])
    expect(second.code).toBe(0)
    expect(second.out).toContain('Nothing to change')
    expect(second.out).toContain('unchanged SessionStart')
    expect(readFileSync(s.settings, 'utf8')).toBe(once)
    expect(readdirSync(s.claudeDir).sort()).toEqual(filesOnce)
    for (const event of NON_BLOCKING_HOOK_EVENTS) expect(ours(readJson(s.settings), event), event).toHaveLength(1)
  })

  it('updates our entry in place when the token mode changes, rather than adding a second one', () => {
    const s = setup()
    s.run(['install', '--apply'])
    const secrets = loadOrCreateSecrets(s.dataDir)
    const r = s.run(['install', '--apply', '--embed-token'])
    expect(r.code).toBe(0)
    expect(r.out).toContain('updated   Stop')
    const after = readJson(s.settings)
    for (const event of NON_BLOCKING_HOOK_EVENTS) expect(ours(after, event)).toHaveLength(1)
    expect(JSON.stringify(after)).toContain(secrets.hookToken)
    // ...and back again.
    s.run(['install', '--apply'])
    expect(JSON.stringify(readJson(s.settings))).not.toContain(secrets.hookToken)
  })

  it('keeps another handler of ours for a different port as somebody else\'s, and adds this port\'s', () => {
    const s = setup()
    s.run(['install', '--apply', '--port', '7000'])
    s.run(['install', '--apply', '--port', '7421'])
    const after = readJson(s.settings)
    expect(ours(after, 'Stop', 7000)).toHaveLength(1)
    expect(ours(after, 'Stop', 7421)).toHaveLength(1)
  })

  it('honours --skip', () => {
    const s = setup()
    s.run(['install', '--apply', '--skip', 'PermissionRequest'])
    const after = readJson(s.settings)
    expect(ours(after, 'PermissionRequest')).toHaveLength(0)
    expect(ours(after, 'Stop')).toHaveLength(1)
  })

  it('preserves CRLF line endings and the existing indentation', () => {
    const s = setup()
    mkdirSync(s.claudeDir, { recursive: true })
    writeFileSync(s.settings, `${JSON.stringify({ model: 'opus' }, null, '\t').replace(/\n/g, '\r\n')}\r\n`)
    s.run(['install', '--apply'])
    const text = readFileSync(s.settings, 'utf8')
    expect(text).toContain('\r\n')
    expect(text.replace(/\r\n/g, '')).not.toContain('\n')
    expect(text).toMatch(/\r\n\t"model": "opus"/)
    expect(text.endsWith('\r\n')).toBe(true)
    expect(JSON.parse(text).hooks.Stop).toBeDefined()
  })

  it('tolerates a BOM and an empty file', () => {
    const s = setup()
    mkdirSync(s.claudeDir, { recursive: true })
    writeFileSync(s.settings, `\uFEFF${JSON.stringify({ model: 'x' })}`)
    expect(s.run(['install', '--apply']).code).toBe(0)
    expect(readJson(s.settings).model).toBe('x')
    writeFileSync(s.settings, '   \n')
    expect(s.run(['install', '--apply']).code).toBe(0)
    expect(ours(readJson(s.settings), 'Stop')).toHaveLength(1)
  })

  it('refuses to touch a settings file it cannot parse, and leaves no backup behind', () => {
    const s = setup()
    mkdirSync(s.claudeDir, { recursive: true })
    writeFileSync(s.settings, '{ "model": "x", // a comment\n')
    const r = s.run(['install', '--apply'])
    expect(r.code).toBe(1)
    expect(r.err).toContain('not valid JSON')
    expect(r.err).toContain('Nothing was changed')
    expect(readFileSync(s.settings, 'utf8')).toBe('{ "model": "x", // a comment\n')
    expect(readdirSync(s.claudeDir)).toEqual(['settings.json'])
  })

  it('refuses a hooks value of the wrong shape', () => {
    const s = setup()
    mkdirSync(s.claudeDir, { recursive: true })
    for (const bad of [{ hooks: 'nope' }, { hooks: [] }, { hooks: { Stop: 'x' } }, []]) {
      writeFileSync(s.settings, JSON.stringify(bad))
      const r = s.run(['install', '--apply'])
      expect(r.code, JSON.stringify(bad)).toBe(1)
      expect(readFileSync(s.settings, 'utf8')).toBe(JSON.stringify(bad))
    }
  })

  it('--settings and --config-dir pick the file', () => {
    const s = setup()
    const custom = join(s.dir, 'elsewhere', 'my-settings.json')
    expect(s.run(['install', '--apply', '--settings', custom]).code).toBe(0)
    expect(ours(readJson(custom), 'Stop')).toHaveLength(1)
    expect(existsSync(s.settings)).toBe(false)
    const dir = join(s.dir, 'cfg2')
    s.run(['install', '--apply', '--config-dir', dir])
    expect(existsSync(join(dir, 'settings.json'))).toBe(true)
  })
})

describe('hooks uninstall', () => {
  it('without --apply only shows what would be removed', () => {
    const s = setup()
    s.run(['install', '--apply'])
    const before = readFileSync(s.settings, 'utf8')
    const r = s.run(['uninstall'])
    expect(r.code).toBe(0)
    expect(r.out).toContain('removed   Stop')
    expect(r.out).toContain('Dry run')
    expect(readFileSync(s.settings, 'utf8')).toBe(before)
  })

  it('removes only the entries pointing at our URL and restores the file to what the user had', () => {
    const s = setup()
    mkdirSync(s.claudeDir, { recursive: true })
    writeFileSync(s.settings, JSON.stringify(USER_SETTINGS, null, 2))
    s.run(['install', '--apply'])
    // A handler of someone else that merely lives in the same group as ours must survive.
    const mid = readJson(s.settings) as { hooks: Record<string, Array<{ hooks: unknown[] }>> }
    mid.hooks.Stop![0]!.hooks.push({ type: 'command', command: 'echo stopped' })
    // ...and an http hook for another port or path is not ours.
    mid.hooks.Stop!.push({ hooks: [{ type: 'http', url: 'http://127.0.0.1:9999/hooks/Stop' }, { type: 'http', url: `http://127.0.0.1:${PORT}/other` }] })
    writeFileSync(s.settings, JSON.stringify(mid, null, 2))

    const r = s.run(['uninstall', '--apply'])
    expect(r.code).toBe(0)
    const after = readJson(s.settings) as { model?: string; hooks: Record<string, Array<{ hooks: unknown[] }>> }
    for (const event of NON_BLOCKING_HOOK_EVENTS) expect(ours(after, event), event).toHaveLength(0)
    expect(after.hooks.PostToolUse).toEqual(USER_SETTINGS.hooks.PostToolUse)
    expect(after.hooks.Notification).toEqual(USER_SETTINGS.hooks.Notification)
    expect(after.hooks.PreToolUse).toEqual(USER_SETTINGS.hooks.PreToolUse)
    expect(after.hooks.Stop).toEqual([
      { hooks: [{ type: 'command', command: 'echo stopped' }] },
      { hooks: [{ type: 'http', url: 'http://127.0.0.1:9999/hooks/Stop' }, { type: 'http', url: `http://127.0.0.1:${PORT}/other` }] },
    ])
    expect(Object.keys(after.hooks).sort()).toEqual(['Notification', 'PostToolUse', 'PreToolUse', 'Stop'])
    expect(after.model).toBe('opus')
    expect(readdirSync(s.claudeDir).some((f) => f.startsWith('settings.json.bak-'))).toBe(true)
  })

  it('drops the hooks key entirely when we emptied it, and installs cleanly again afterwards', () => {
    const s = setup()
    mkdirSync(s.claudeDir, { recursive: true })
    writeFileSync(s.settings, JSON.stringify({ model: 'opus' }, null, 2))
    s.run(['install', '--apply'])
    s.run(['uninstall', '--apply'])
    expect(readJson(s.settings)).toEqual({ model: 'opus' })
    s.run(['install', '--apply'])
    for (const event of NON_BLOCKING_HOOK_EVENTS) expect(ours(readJson(s.settings), event)).toHaveLength(1)
  })

  it('is a no-op when nothing of ours is there or the file does not exist', () => {
    const s = setup()
    const missing = s.run(['uninstall', '--apply'])
    expect(missing.code).toBe(0)
    expect(existsSync(s.settings)).toBe(false)
    mkdirSync(s.claudeDir, { recursive: true })
    writeFileSync(s.settings, JSON.stringify(USER_SETTINGS, null, 2))
    const before = readFileSync(s.settings, 'utf8')
    const r = s.run(['uninstall', '--apply'])
    expect(r.out).toContain('Nothing to change')
    expect(readFileSync(s.settings, 'utf8')).toBe(before)
    expect(readdirSync(s.claudeDir)).toEqual(['settings.json'])
  })
})

describe('hooks token', () => {
  it('prints the token from secrets.json, and fails without one', () => {
    const s = setup()
    expect(s.run(['token']).code).toBe(1)
    const secrets = loadOrCreateSecrets(s.dataDir)
    const r = s.run(['token'])
    expect(r.code).toBe(0)
    expect(r.out.trim()).toBe(secrets.hookToken)
  })

  it('--rotate writes a new token and keeps the browser sessions', () => {
    const s = setup()
    expect(s.run(['token', '--rotate']).code).toBe(1)
    const secrets = loadOrCreateSecrets(s.dataDir)
    const r = s.run(['token', '--rotate'])
    expect(r.code).toBe(0)
    const next = readSecretsFile(s.dataDir)!
    expect(next.hookToken).not.toBe(secrets.hookToken)
    expect(r.out.trim()).toBe(next.hookToken)
    expect(next.sessions).toEqual(secrets.sessions)
  })
})

describe('resolveClaudeDir and helpers', () => {
  it('uses CLAUDE_CONFIG_DIR, else <home>/.claude, with Windows rules on win32', () => {
    expect(resolveClaudeDir({ CLAUDE_CONFIG_DIR: '/cfg/claude' }, 'linux', '/home/u')).toBe('/cfg/claude')
    expect(resolveClaudeDir({}, 'linux', '/home/u')).toBe('/home/u/.claude')
    expect(resolveClaudeDir({}, 'win32', 'C:\\Users\\Ada')).toBe('C:\\Users\\Ada\\.claude')
    expect(resolveClaudeDir({ CLAUDE_CONFIG_DIR: 'D:\\cfg\\claude' }, 'win32', 'C:\\Users\\Ada')).toBe('D:\\cfg\\claude')
    expect(resolveClaudeDir({ CLAUDE_CONFIG_DIR: '  ' }, 'linux', '/home/u')).toBe('/home/u/.claude')
  })

  it('makes backup stamps that are safe in a Windows file name', () => {
    const stamp = backupStamp(new Date('2026-11-02T10:11:12.345Z'))
    expect(stamp).toBe('20261102T101112')
    expect(stamp).not.toMatch(/[:\\/<>"|?*]/)
  })
})

describe('pure merge and remove', () => {
  const opts = { port: PORT }

  it('never mutates its input', () => {
    const input = structuredClone(USER_SETTINGS)
    const snapshot = JSON.stringify(input)
    mergeHooks(input, opts)
    removeHooks(input, PORT)
    expect(JSON.stringify(input)).toBe(snapshot)
  })

  it('reports added, then unchanged, then updated, then removed', () => {
    const first = mergeHooks({}, opts)
    expect(new Set(first.changes.map((c) => c.kind))).toEqual(new Set(['added']))
    expect(first.changes.map((c) => c.event)).toEqual([...NON_BLOCKING_HOOK_EVENTS])
    const second = mergeHooks(first.settings, opts)
    expect(new Set(second.changes.map((c) => c.kind))).toEqual(new Set(['unchanged']))
    expect(second.settings).toEqual(first.settings)
    const third = mergeHooks(first.settings, { ...opts, embedToken: 'tok' })
    expect(new Set(third.changes.map((c) => c.kind))).toEqual(new Set(['updated']))
    const gone = removeHooks(third.settings, PORT)
    expect(new Set(gone.changes.map((c) => c.kind))).toEqual(new Set(['removed']))
    expect(gone.settings).toEqual({})
  })

  it('treats a handler as ours only when the URL matches the event it is registered under', () => {
    expect(isOurHandler({ url: hookUrl(PORT, 'Stop') }, 'Stop', PORT)).toBe(true)
    expect(isOurHandler({ url: hookUrl(PORT, 'Stop') }, 'SessionEnd', PORT)).toBe(false)
    expect(isOurHandler({ url: hookUrl(7000, 'Stop') }, 'Stop', PORT)).toBe(false)
    expect(isOurHandler({ command: 'x' }, 'Stop', PORT)).toBe(false)
    expect(isOurHandler(null, 'Stop', PORT)).toBe(false)
    expect(isOurHandler('http://127.0.0.1:7421/hooks/Stop', 'Stop', PORT)).toBe(false)
  })

  it('skips malformed groups instead of crashing', () => {
    const weird = { hooks: { Stop: [null, 'x', { matcher: 'a' }, { hooks: 'no' }, { hooks: [{ type: 'command', command: 'keep' }] }] } }
    const merged = mergeHooks(weird, opts)
    expect((merged.settings.hooks as Record<string, unknown[]>).Stop).toHaveLength(6)
    const removed = removeHooks(merged.settings, PORT)
    expect((removed.settings.hooks as Record<string, unknown[]>).Stop).toEqual(weird.hooks.Stop)
  })

  it('throws a SettingsShapeError for shapes it cannot edit safely', () => {
    expect(() => mergeHooks([], opts)).toThrow(SettingsShapeError)
    expect(() => mergeHooks({ hooks: 5 }, opts)).toThrow(SettingsShapeError)
    expect(() => removeHooks({ hooks: [] }, PORT)).toThrow(SettingsShapeError)
    expect(() => mergeHooks({ hooks: { Stop: {} } }, opts)).toThrow(SettingsShapeError)
  })

  it('builds fail-open handlers with short timeouts and the documented fields', () => {
    const h = buildHandler('PostToolUse', opts)
    expect(h).toEqual({
      type: 'http',
      url: 'http://127.0.0.1:7421/hooks/PostToolUse',
      timeout: 2,
      onFailure: 'continue',
      headers: { Authorization: `Bearer $${TOKEN_ENV_VAR}` },
      allowedEnvVars: [TOKEN_ENV_VAR],
    })
    expect(buildHandler('SessionEnd', opts).timeout).toBe(1)
    expect(Object.keys(buildHooksBlock({ port: 1, skip: ['Stop'] }))).not.toContain('Stop')
  })
})

describe('lineDiff', () => {
  it('is empty for identical text and shows added and removed lines with context otherwise', () => {
    expect(lineDiff('a\nb', 'a\nb')).toBe('')
    const d = lineDiff('{\n  "a": 1\n}', '{\n  "a": 1,\n  "b": 2\n}')
    expect(d).toContain('-   "a": 1')
    expect(d).toContain('+   "a": 1,')
    expect(d).toContain('+   "b": 2')
    const far = lineDiff(Array.from({ length: 30 }, (_, i) => `l${i}`).join('\n'), Array.from({ length: 30 }, (_, i) => (i === 15 ? 'CHANGED' : `l${i}`)).join('\n'))
    expect(far).toContain('+ CHANGED')
    expect(far).not.toContain('l1\n')
  })
})
