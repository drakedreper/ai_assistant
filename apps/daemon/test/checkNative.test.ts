import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { checkNative, makeProbe, MIN_NODE, nodeTooOld, type ProbeResult } from '../src/cli/checkNative'

const daemonDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = path.resolve(daemonDir, '../..')
const daemonPackageJson = path.join(daemonDir, 'package.json')

const worked = (version = '3.53.4'): ProbeResult => ({ status: 0, signal: null, stdout: version, stderr: '' })

function run(nodeVersion: string, result: ProbeResult = worked(), platform = 'win32') {
  const probe = vi.fn(() => result)
  const outcome = checkNative({ nodeVersion, platform, arch: 'x64', execPath: 'node', daemonPackageJson: 'package.json', probe })
  return { outcome, probe, text: outcome.lines.join('\n') }
}

describe('nodeTooOld', () => {
  it.each(['22.12.0', 'v22.13.1', '22.0.0', '20.19.0', '21.7.3'])('%s is too old', (version) => {
    expect(nodeTooOld(version)).toBe(true)
  })
  it.each(['22.14.0', 'v22.23.4', '23.6.0', '24.0.0', '25.1.0'])('%s is fine', (version) => {
    expect(nodeTooOld(version)).toBe(false)
  })
})

describe('checkNative', () => {
  it('reports a Node that is too old without touching the addon (on 22.12 and 22.13 the addon segfaults)', () => {
    for (const version of ['22.12.0', '22.13.1']) {
      const { outcome, probe, text } = run(version)
      expect(outcome.ok).toBe(false)
      expect(probe).not.toHaveBeenCalled()
      expect(text).toContain(`Node.js ${version} is too old`)
      expect(text).toContain(`${MIN_NODE.major}.${MIN_NODE.minor}`)
    }
  })

  it('passes and names SQLite, the Node version and the platform', () => {
    const { outcome, probe, text } = run('22.14.0')
    expect(outcome.ok).toBe(true)
    expect(probe).toHaveBeenCalledTimes(1)
    expect(text).toBe('Database library OK: SQLite 3.53.4 (Node 22.14.0, win32 x64).')
  })

  it('a crash by signal is reported with the signal and the Node version', () => {
    const { outcome, text } = run('22.20.0', { status: null, signal: 'SIGSEGV', stdout: '', stderr: '' }, 'linux')
    expect(outcome.ok).toBe(false)
    expect(text).toContain('it crashed (SIGSEGV)')
    expect(text).toContain('Node 22.20.0, linux x64')
  })

  it('a Windows access violation is spelled out', () => {
    const { outcome, text } = run('22.20.0', { status: 3221225477, signal: null, stdout: '', stderr: '' })
    expect(outcome.ok).toBe(false)
    expect(text).toContain('0xC0000005, access violation')
  })

  it('a missing DLL is spelled out', () => {
    const { text } = run('22.20.0', { status: 3221225781, signal: null, stdout: '', stderr: '' })
    expect(text).toContain('0xC0000135, a DLL it needs was not found')
  })

  it('shows the first lines of what the probe printed', () => {
    const stderr = 'Error: The specified module could not be found.\n  \\\\?\\C:\\x\\better_sqlite3.node\n\nat a\nat b\nat c\nat d\n'
    const { text } = run('22.20.0', { status: 1, signal: null, stdout: '', stderr })
    expect(text).toContain('it exited with code 1')
    expect(text).toContain('  Error: The specified module could not be found.')
    expect(text).toContain('  at b')
    expect(text).not.toContain('at c')
    expect(text).toContain('Copy these lines')
  })

  it('a probe that cannot even start is reported', () => {
    const { outcome, text } = run('22.20.0', { status: null, signal: null, stdout: '', stderr: '', error: new Error('spawn node ENOENT') })
    expect(outcome.ok).toBe(false)
    expect(text).toContain('spawn node ENOENT')
  })
})

describe('the real probe (a child process, so a crash cannot take the reporter down)', () => {
  it('opens a database through the installed addon', () => {
    const outcome = checkNative({
      nodeVersion: process.versions.node,
      platform: process.platform,
      arch: process.arch,
      execPath: process.execPath,
      daemonPackageJson,
      probe: makeProbe(),
    })
    expect(outcome.ok, outcome.lines.join('\n')).toBe(true)
    expect(outcome.lines[0]).toMatch(/^Database library OK: SQLite \d+\.\d+\.\d+/)
  })

  it('the command itself prints its verdict and exits 0 (a silent no-op would let the launcher pass by accident)', () => {
    const r = spawnSync(process.execPath, ['--import', 'tsx', 'src/cli/checkNative.ts'], { cwd: daemonDir, encoding: 'utf8' })
    expect(r.stderr).toBe('')
    expect(r.stdout).toMatch(/^Database library OK: SQLite \d+\.\d+\.\d+ \(Node \d+\.\d+\.\d+, \w+ \w+\)\.\r?\n$/)
    expect(r.status).toBe(0)
  })

  it.skipIf(process.platform === 'win32')('survives a child that segfaults and says so', () => {
    const outcome = checkNative({
      nodeVersion: process.versions.node,
      platform: process.platform,
      arch: process.arch,
      execPath: process.execPath,
      daemonPackageJson,
      probe: makeProbe("process.kill(process.pid, 'SIGSEGV')"),
    })
    expect(outcome.ok).toBe(false)
    expect(outcome.lines.join('\n')).toContain('it crashed (SIGSEGV)')
  })
})

describe('the Node minimum is the same everywhere it is stated', () => {
  const min = `${MIN_NODE.major}.${MIN_NODE.minor}`
  const read = (file: string) => readFileSync(path.join(repoRoot, file), 'utf8')

  it('package.json engines', () => {
    expect((JSON.parse(read('package.json')) as { engines: { node: string } }).engines.node).toBe(`>=${min}`)
  })
  it('scripts/start.sh', () => {
    const text = read('scripts/start.sh')
    expect(text).toContain(`(a===${MIN_NODE.major}&&b>=${MIN_NODE.minor})`)
    expect(text).toContain(`Node.js ${min} or newer`)
  })
  it('start.cmd', () => {
    const text = read('start.cmd')
    expect(text).toContain(`(a===${MIN_NODE.major}&&b>=${MIN_NODE.minor})`)
    expect(text).toContain(`Node.js ${min} or newer`)
  })
  it('both launchers run the preflight after the install', () => {
    expect(read('scripts/start.sh')).toMatch(/pnpm install --frozen-lockfile\n[\s\S]*check-native[\s\S]*pnpm --filter @ai-assistant\/web build/)
    expect(read('start.cmd')).toMatch(/pnpm install --frozen-lockfile[\s\S]*check-native[\s\S]*pnpm --filter @ai-assistant\/web build/)
  })
})
