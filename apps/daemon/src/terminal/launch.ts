import { accessSync, constants, statSync } from 'node:fs'
import * as nodePath from 'node:path'
import type { TerminalKind } from '@ai-assistant/shared'

/**
 * Which program a terminal runs. Pure functions over an injected environment and file system so the Windows rules
 * (PATHEXT, claude.exe versus claude.cmd, COMSPEC) are unit-tested with Windows-style strings on Linux.
 *
 *   claude: TERMINAL_CLAUDE_COMMAND (test only), else CLAUDE_EXECUTABLE, else a PATH search that honours PATHEXT on
 *           Windows (claude.exe preferred over claude.cmd / claude.bat). Missing: a `claude_not_found` error that
 *           says how to fix it. The daemon never reads, copies or proxies Claude credentials: the process signs in
 *           by itself, like in any terminal.
 *   shell:  Windows: Windows PowerShell (System32, then PATH), then COMSPEC, then cmd.exe.
 *           Elsewhere: $SHELL when it is an absolute executable, else /bin/sh.
 */

export type LaunchErrorCode = 'claude_not_found' | 'shell_not_found' | 'bad_command_override'

export class LaunchError extends Error {
  override name = 'LaunchError'
  constructor(
    readonly code: LaunchErrorCode,
    message: string,
  ) {
    super(message)
  }
}

export interface LaunchFs {
  isFile(path: string): boolean
  isExecutable(path: string): boolean
}

export const nodeLaunchFs: LaunchFs = {
  isFile(p) {
    try {
      return statSync(p).isFile()
    } catch {
      return false
    }
  },
  isExecutable(p) {
    try {
      if (!statSync(p).isFile()) return false
      accessSync(p, constants.X_OK)
      return true
    } catch {
      return false
    }
  },
}

export interface LaunchSpec {
  kind: TerminalKind
  /** The program handed to the pty (absolute when it could be resolved). */
  file: string
  /** argv, or on Windows a ready-made command line (for .cmd wrappers). */
  args: string | string[]
  /** Shown in the UI. */
  title: string
}

export const CLAUDE_HELP =
  'Claude Code was not found on this PC. Install it from https://docs.claude.com/en/docs/claude-code/setup (the native installer puts claude.exe in your user folder), open a NEW terminal so PATH updates, then restart the daemon. If it is installed somewhere unusual, set CLAUDE_EXECUTABLE to the full path of claude.exe (for example C:\\Users\\you\\.local\\bin\\claude.exe) and restart the daemon.'

const flavour = (platform: NodeJS.Platform) => (platform === 'win32' ? nodePath.win32 : nodePath.posix)

/** Windows environment lookups are case-insensitive. */
export function envGet(env: Readonly<Record<string, string | undefined>>, name: string, platform: NodeJS.Platform): string | undefined {
  if (platform !== 'win32') return env[name]
  const upper = name.toUpperCase()
  for (const [k, v] of Object.entries(env)) if (k.toUpperCase() === upper) return v
  return undefined
}

const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD'
/** Only these can be started by CreateProcess (directly, or through cmd.exe for the batch ones). */
const RUNNABLE_EXT = ['.exe', '.com', '.cmd', '.bat']

/** PATHEXT, lower-cased, runnable only, with .exe first: `claude.exe` beats a `claude.cmd` shim next to it. */
export function windowsExtensions(env: Readonly<Record<string, string | undefined>>): string[] {
  const raw = envGet(env, 'PATHEXT', 'win32') ?? DEFAULT_PATHEXT
  const listed = raw
    .split(';')
    .map((e) => e.trim().toLowerCase())
    .filter((e) => RUNNABLE_EXT.includes(e))
  const all = listed.length > 0 ? listed : RUNNABLE_EXT
  return [...all].sort((a, b) => (a === '.exe' ? -1 : b === '.exe' ? 1 : 0))
}

/**
 * Search PATH for `name`. Empty and relative PATH entries are ignored on purpose: they would mean "the daemon's
 * current directory", which must never be searched for a program that is then run as the user.
 */
export function findOnPath(name: string, env: Readonly<Record<string, string | undefined>>, platform: NodeJS.Platform, fs: LaunchFs): string | undefined {
  const f = flavour(platform)
  const pathVar = envGet(env, 'PATH', platform)
  if (!pathVar) return undefined
  const delimiter = platform === 'win32' ? ';' : ':'
  const hasExt = platform === 'win32' && RUNNABLE_EXT.includes(f.extname(name).toLowerCase())
  const names = platform === 'win32' ? (hasExt ? [name] : windowsExtensions(env).map((e) => `${name}${e}`)) : [name]
  for (const rawDir of pathVar.split(delimiter)) {
    const dir = rawDir.trim().replace(/^"(.*)"$/, '$1')
    if (!dir || !f.isAbsolute(dir)) continue
    for (const n of names) {
      const candidate = f.join(dir, n)
      if (platform === 'win32' ? fs.isFile(candidate) : fs.isExecutable(candidate)) return candidate
    }
  }
  return undefined
}

/** `C:\x\claude` -> `C:\x\claude.exe` when only the extension is missing. */
function withWindowsExtension(path: string, env: Readonly<Record<string, string | undefined>>, fs: LaunchFs): string | undefined {
  if (fs.isFile(path)) return RUNNABLE_EXT.includes(nodePath.win32.extname(path).toLowerCase()) ? path : undefined
  for (const e of windowsExtensions(env)) if (fs.isFile(`${path}${e}`)) return `${path}${e}`
  return undefined
}

/**
 * A .cmd or .bat cannot be started like an .exe. Wrap it in cmd.exe with the documented `/d /s /c ""path""`
 * quoting. A path holding a double quote or a percent sign (cmd expands %VAR% even inside quotes) is refused.
 */
export function wrapBatch(path: string, env: Readonly<Record<string, string | undefined>>, fs: LaunchFs, errorCode: LaunchErrorCode): { file: string; args: string } {
  if (/["%\r\n\0]/.test(path)) throw new LaunchError(errorCode, 'That program path contains characters that cannot be passed to cmd.exe safely (a double quote or a percent sign). Use claude.exe or move the file.')
  const systemRoot = envGet(env, 'SystemRoot', 'win32')
  const sysCmd = systemRoot ? nodePath.win32.join(systemRoot, 'System32', 'cmd.exe') : undefined
  const comspec = envGet(env, 'ComSpec', 'win32')
  const file = (sysCmd && fs.isFile(sysCmd) ? sysCmd : undefined) ?? (comspec && nodePath.win32.isAbsolute(comspec) ? comspec : undefined) ?? 'cmd.exe'
  return { file, args: `/d /s /c ""${path}""` }
}

function fromProgramPath(kind: TerminalKind, program: string, title: string, env: Readonly<Record<string, string | undefined>>, platform: NodeJS.Platform, fs: LaunchFs, errorCode: LaunchErrorCode): LaunchSpec {
  if (platform === 'win32' && /\.(cmd|bat)$/i.test(program)) {
    const w = wrapBatch(program, env, fs, errorCode)
    return { kind, file: w.file, args: w.args, title }
  }
  return { kind, file: program, args: [], title }
}

/** TERMINAL_CLAUDE_COMMAND: a JSON array of strings (program first), or a single program path. TEST ONLY. */
export function parseCommandOverride(raw: string): { file: string; args: string[] } {
  const text = raw.trim()
  if (text.startsWith('[')) {
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      throw new LaunchError('bad_command_override', 'TERMINAL_CLAUDE_COMMAND is not valid JSON.')
    }
    if (!Array.isArray(parsed) || parsed.length === 0 || !parsed.every((x) => typeof x === 'string' && x.length > 0 && !x.includes('\0'))) {
      throw new LaunchError('bad_command_override', 'TERMINAL_CLAUDE_COMMAND must be a JSON array of non-empty strings.')
    }
    const [file, ...args] = parsed as string[]
    return { file: file as string, args }
  }
  if (text.includes('\0') || text.length === 0 || text.startsWith('{')) throw new LaunchError('bad_command_override', 'TERMINAL_CLAUDE_COMMAND must be a program path or a JSON array.')
  return { file: text, args: [] }
}

export interface ClaudeLaunchOptions {
  env: Readonly<Record<string, string | undefined>>
  platform: NodeJS.Platform
  fs: LaunchFs
  /** CLAUDE_EXECUTABLE. */
  claudeExecutable?: string | undefined
  /** TERMINAL_CLAUDE_COMMAND (tests only). */
  commandOverride?: string | undefined
}

export function resolveClaudeLaunch(o: ClaudeLaunchOptions): LaunchSpec {
  if (o.commandOverride) {
    const c = parseCommandOverride(o.commandOverride)
    return { kind: 'claude', file: c.file, args: c.args, title: 'Claude Code (test command)' }
  }
  const f = flavour(o.platform)
  if (o.claudeExecutable) {
    const explicit = o.claudeExecutable
    const found =
      o.platform === 'win32'
        ? withWindowsExtension(explicit, o.env, o.fs)
        : o.fs.isExecutable(explicit)
          ? explicit
          : undefined
    if (!found || !f.isAbsolute(found)) {
      throw new LaunchError('claude_not_found', `CLAUDE_EXECUTABLE points to a file that does not exist or is not a full path (${f.basename(explicit)}). ${CLAUDE_HELP}`)
    }
    return fromProgramPath('claude', found, 'Claude Code', o.env, o.platform, o.fs, 'claude_not_found')
  }
  const onPath = findOnPath('claude', o.env, o.platform, o.fs)
  if (!onPath) throw new LaunchError('claude_not_found', CLAUDE_HELP)
  return fromProgramPath('claude', onPath, 'Claude Code', o.env, o.platform, o.fs, 'claude_not_found')
}

export interface ShellLaunchOptions {
  env: Readonly<Record<string, string | undefined>>
  platform: NodeJS.Platform
  fs: LaunchFs
}

export function resolveShellLaunch(o: ShellLaunchOptions): LaunchSpec {
  if (o.platform === 'win32') {
    const systemRoot = envGet(o.env, 'SystemRoot', 'win32')
    const system32Ps = systemRoot ? nodePath.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : undefined
    const ps = (system32Ps && o.fs.isFile(system32Ps) ? system32Ps : undefined) ?? findOnPath('powershell.exe', o.env, 'win32', o.fs)
    if (ps) return { kind: 'shell', file: ps, args: ['-NoLogo'], title: 'PowerShell' }
    const comspec = envGet(o.env, 'ComSpec', 'win32')
    if (comspec && nodePath.win32.isAbsolute(comspec) && o.fs.isFile(comspec)) return { kind: 'shell', file: comspec, args: [], title: 'Command Prompt' }
    const cmd = findOnPath('cmd.exe', o.env, 'win32', o.fs)
    if (cmd) return { kind: 'shell', file: cmd, args: [], title: 'Command Prompt' }
    throw new LaunchError('shell_not_found', 'No shell was found (PowerShell or the COMSPEC command prompt).')
  }
  const sh = o.env.SHELL
  if (sh && nodePath.posix.isAbsolute(sh) && o.fs.isExecutable(sh)) return { kind: 'shell', file: sh, args: [], title: nodePath.posix.basename(sh) }
  if (o.fs.isExecutable('/bin/sh')) return { kind: 'shell', file: '/bin/sh', args: [], title: 'sh' }
  const found = findOnPath('sh', o.env, o.platform, o.fs)
  if (found) return { kind: 'shell', file: found, args: [], title: 'sh' }
  throw new LaunchError('shell_not_found', 'No shell was found ($SHELL or /bin/sh).')
}
