import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

/**
 * Preflight for the launchers (start.cmd, scripts/start.sh): run right after `pnpm install`, before the web build.
 *
 * better-sqlite3 ships prebuilt binaries made with Node-API 10, which Node has from 22.14. Measured with the bundled
 * linux-x64 binary: on Node 22.12.0 and 22.13.1 `require` succeeds and the first `new Database()` segfaults, so a Node
 * that is too old is reported before anything touches the addon, and the real probe runs in a child process (a crash
 * there would otherwise end this reporter without a word).
 */

/** Oldest Node that runs the bundled better-sqlite3. Keep in step with package.json engines, start.cmd and scripts/start.sh (a test checks). */
export const MIN_NODE = { major: 22, minor: 14 } as const

export function nodeTooOld(version: string): boolean {
  const [major = 0, minor = 0] = version.replace(/^v/, '').split('.').map(Number)
  return major < MIN_NODE.major || (major === MIN_NODE.major && minor < MIN_NODE.minor)
}

export interface ProbeResult {
  status: number | null
  signal: string | null
  stdout: string
  stderr: string
  error?: Error | undefined
}

export type Probe = (execPath: string, daemonPackageJson: string) => ProbeResult

/** Opens an in-memory database through the real addon, resolved from the daemon package the way the daemon resolves it. */
const OPEN_DATABASE = [
  "const Database = require('node:module').createRequire(process.argv[1])('better-sqlite3')",
  "const db = new Database(':memory:')",
  "process.stdout.write(db.prepare('select sqlite_version() as v').get().v)",
  'db.close()',
].join('; ')

export function makeProbe(source: string = OPEN_DATABASE): Probe {
  return (execPath, daemonPackageJson) => {
    const r = spawnSync(execPath, ['-e', source, daemonPackageJson], { encoding: 'utf8', timeout: 30_000, windowsHide: true })
    return { status: r.status, signal: r.signal, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error }
  }
}

const WINDOWS_CRASHES: Record<number, string> = {
  0xc0000005: 'access violation',
  0xc0000135: 'a DLL it needs was not found',
  0xc000007b: 'wrong architecture or a bad DLL',
}

function describeExit(status: number | null, signal: string | null): string {
  if (signal) return `it crashed (${signal})`
  if (status === null) return 'it did not finish'
  if (status > 0xffff) {
    // Windows reports a crash as an NTSTATUS code.
    const code = status >>> 0
    const known = WINDOWS_CRASHES[code]
    return `it crashed (0x${code.toString(16).toUpperCase()}${known ? `, ${known}` : ''})`
  }
  return `it exited with code ${status}`
}

export interface CheckInput {
  nodeVersion: string
  platform: string
  arch: string
  execPath: string
  daemonPackageJson: string
  probe: Probe
}

export interface CheckOutcome {
  ok: boolean
  lines: string[]
}

export function checkNative(input: CheckInput): CheckOutcome {
  const where = `Node ${input.nodeVersion}, ${input.platform} ${input.arch}`
  const min = `${MIN_NODE.major}.${MIN_NODE.minor}`
  if (nodeTooOld(input.nodeVersion)) {
    return {
      ok: false,
      lines: [
        `Node.js ${input.nodeVersion} is too old for Mira's database library (it needs Node ${min} or newer; on 22.12 and 22.13 it crashes at start).`,
        `Install Node.js ${min} or newer (the current LTS is fine) from https://nodejs.org/ and run this again.`,
      ],
    }
  }
  const r = input.probe(input.execPath, input.daemonPackageJson)
  if (r.error) return { ok: false, lines: [`Could not start Node to test the database library (${where}): ${r.error.message}`] }
  if (r.status === 0) return { ok: true, lines: [`Database library OK: SQLite ${r.stdout.trim()} (${where}).`] }
  const detail = r.stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 4)
  return {
    ok: false,
    lines: [
      `Mira's database library (better-sqlite3) does not work here (${where}): ${describeExit(r.status, r.signal)}.`,
      ...detail.map((line) => `  ${line.slice(0, 200)}`),
      'Copy these lines when you ask for help.',
    ],
  }
}

// Matched by file name, not by comparing URLs: on Windows the drive letter or folder casing and junctions can make
// `import.meta.url` differ from `process.argv[1]`, and a preflight that silently does nothing would pass by accident.
const invokedDirectly = /(^|[\\/])checkNative\.[cm]?[jt]s$/.test(process.argv[1] ?? '')
if (invokedDirectly) {
  const outcome = checkNative({
    nodeVersion: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    execPath: process.execPath,
    daemonPackageJson: fileURLToPath(new URL('../../package.json', import.meta.url)),
    probe: makeProbe(),
  })
  for (const line of outcome.lines) (outcome.ok ? process.stdout : process.stderr).write(`${line}\n`)
  process.exitCode = outcome.ok ? 0 : 1
}
