import { realpathSync, statSync } from 'node:fs'
import * as nodePath from 'node:path'

/**
 * Where a terminal may START. This decides the working directory of a new terminal; it is NOT a sandbox: a shell
 * can `cd` anywhere the user can. What it does protect is the API: a page or a bug cannot make the daemon launch a
 * process in an arbitrary place, in particular not on a network share (UNC paths are refused outright).
 *
 * The rules, in the order they are applied (every refusal has a stable code):
 *   - the path is a non-empty absolute path of a sane length, without NUL;              cwd_empty, cwd_not_absolute
 *   - no UNC or device paths (\\server\share, //server/share, \\?\..., \\.\...);          cwd_unc
 *   - no ".." segment at all (not even one that stays inside);                           cwd_traversal
 *   - Windows: a drive letter is required (no "\dir" or "C:dir"), and no segment holds a
 *     character Windows does not allow, an alternate data stream (":") or ends in a dot
 *     or a space (Windows would silently strip them);                                   cwd_invalid
 *   - the path exists and, after realpath (symlinks, junctions, 8.3 names resolved), is
 *     still not a UNC path and is a directory;                                          cwd_not_found, cwd_not_directory
 *   - the REAL path is inside a known project root or the user's home (each root is
 *     realpath'ed too, a filesystem root such as "/" or "C:\" is never accepted as a
 *     root). Comparison is case-insensitive on Windows.                                  cwd_outside
 *
 * Everything is a pure function of its inputs plus an injected `fs`, so Windows-style strings can be unit-tested
 * on Linux with a fake file system. The real realpath must be the NATIVE one (fs.realpathSync.native) so 8.3 short
 * names and the canonical case come back on Windows.
 */

export type CwdRefusal =
  | 'cwd_empty'
  | 'cwd_not_absolute'
  | 'cwd_unc'
  | 'cwd_traversal'
  | 'cwd_invalid'
  | 'cwd_not_found'
  | 'cwd_not_directory'
  | 'cwd_outside'

export interface CwdFs {
  /** The canonical path, throwing (any error) when it does not exist. */
  realpath(path: string): string
  isDirectory(path: string): boolean
}

export interface CwdContext {
  platform: NodeJS.Platform
  home: string
  /** Root paths of known projects, as stored (they are realpath'ed here). */
  projectRoots: readonly string[]
  fs: CwdFs
}

export type CwdResult = { ok: true; cwd: string; root: string } | { ok: false; code: CwdRefusal; message: string }

const MAX_PATH_CHARS = 4096

const MESSAGES: Record<CwdRefusal, string> = {
  cwd_empty: 'No folder was given.',
  cwd_not_absolute: 'The folder must be a full path (for example C:\\Users\\you\\project).',
  cwd_unc: 'Network paths (\\\\server\\share) are not allowed as a terminal folder.',
  cwd_traversal: 'The folder path must not contain "..".',
  cwd_invalid: 'The folder path contains characters that are not allowed.',
  cwd_not_found: 'That folder does not exist.',
  cwd_not_directory: 'That path is not a folder.',
  cwd_outside: 'A terminal can only start inside one of your projects or your home folder.',
}

const refuse = (code: CwdRefusal): CwdResult => ({ ok: false, code, message: MESSAGES[code] })

const flavour = (platform: NodeJS.Platform) => (platform === 'win32' ? nodePath.win32 : nodePath.posix)

/** \\server, //server, \\?\, \\.\ (Windows); \\ at the start on any platform (never a POSIX absolute path). */
export function isUncLike(p: string, platform: NodeJS.Platform): boolean {
  if (/^\\\\/.test(p)) return true
  return platform === 'win32' && /^[\\/]{2}/.test(p)
}

const WIN_BAD_CHARS = /[<>"|?*\u0000-\u001f]/

/** String-level checks, before the file system is touched. Returns the normalised path or a refusal. */
function checkSyntax(raw: string, platform: NodeJS.Platform): { ok: true; path: string } | { ok: false; code: CwdRefusal } {
  if (typeof raw !== 'string' || raw.trim().length === 0) return { ok: false, code: 'cwd_empty' }
  if (raw.length > MAX_PATH_CHARS || raw.includes('\0')) return { ok: false, code: 'cwd_invalid' }
  if (isUncLike(raw, platform)) return { ok: false, code: 'cwd_unc' }
  const win = platform === 'win32'
  if (win) {
    if (!/^[A-Za-z]:[\\/]/.test(raw)) return { ok: false, code: 'cwd_not_absolute' }
  } else if (!raw.startsWith('/')) {
    return { ok: false, code: 'cwd_not_absolute' }
  }
  const rest = win ? raw.slice(2) : raw
  const segments = rest.split(win ? /[\\/]/ : /\//)
  for (const seg of segments) {
    if (seg === '..') return { ok: false, code: 'cwd_traversal' }
    if (win && seg !== '' && seg !== '.') {
      if (WIN_BAD_CHARS.test(seg) || seg.includes(':') || /[. ]$/.test(seg)) return { ok: false, code: 'cwd_invalid' }
    }
  }
  return { ok: true, path: flavour(platform).resolve(raw) }
}

/** `\\?\C:\x` becomes `C:\x`; `\\?\UNC\...` and `\\server\...` stay UNC-like (refused by the caller). */
function stripExtendedPrefix(p: string, platform: NodeJS.Platform): string {
  if (platform !== 'win32') return p
  const m = /^\\\\\?\\([A-Za-z]:\\.*)$/s.exec(p)
  return m?.[1] ?? p
}

function isFilesystemRoot(p: string, platform: NodeJS.Platform): boolean {
  const f = flavour(platform)
  return f.dirname(p) === p
}

/** True when `child` is `root` or below it. Case-insensitive on Windows; boundary-safe ("/a/bc" is not inside "/a/b"). */
export function isInside(root: string, child: string, platform: NodeJS.Platform): boolean {
  const f = flavour(platform)
  const norm = (p: string) => (platform === 'win32' ? f.resolve(p).toLowerCase() : f.resolve(p))
  const rel = f.relative(norm(root), norm(child))
  if (rel === '') return true
  if (f.isAbsolute(rel)) return false // another drive
  return rel !== '..' && !rel.startsWith(`..${f.sep}`)
}

function realDirectory(p: string, ctx: CwdContext): { ok: true; path: string } | { ok: false; code: CwdRefusal } {
  let real: string
  try {
    real = stripExtendedPrefix(ctx.fs.realpath(p), ctx.platform)
  } catch {
    return { ok: false, code: 'cwd_not_found' }
  }
  if (isUncLike(real, ctx.platform) || /^\\\\\?\\/.test(real)) return { ok: false, code: 'cwd_unc' }
  let dir = false
  try {
    dir = ctx.fs.isDirectory(real)
  } catch {
    dir = false
  }
  return dir ? { ok: true, path: real } : { ok: false, code: 'cwd_not_directory' }
}

function realRoots(roots: readonly string[], ctx: CwdContext): string[] {
  const out: string[] = []
  const key = (p: string) => (ctx.platform === 'win32' ? p.toLowerCase() : p)
  for (const r of roots) {
    const syn = checkSyntax(r, ctx.platform)
    if (!syn.ok) continue
    const real = realDirectory(syn.path, ctx)
    if (!real.ok) continue
    if (isFilesystemRoot(real.path, ctx.platform)) continue // "/" or "C:\" would allow everything
    if (!out.some((o) => key(o) === key(real.path))) out.push(real.path)
  }
  return out
}

/**
 * An explicit folder: it must resolve inside a known project root or the user's home.
 * `restrictTo` narrows the allowed roots (used when a projectId was given as well).
 */
export function resolveTerminalCwd(requested: string, ctx: CwdContext, restrictTo?: readonly string[]): CwdResult {
  const syn = checkSyntax(requested, ctx.platform)
  if (!syn.ok) return refuse(syn.code)
  const real = realDirectory(syn.path, ctx)
  if (!real.ok) return refuse(real.code)
  const roots = realRoots(restrictTo ?? [...ctx.projectRoots, ctx.home], ctx)
  const root = roots.find((r) => isInside(r, real.path, ctx.platform))
  if (!root) return refuse('cwd_outside')
  return { ok: true, cwd: real.path, root }
}

/** A project's own root as the starting folder. It must still exist, be a directory and not be a filesystem root. */
export function resolveProjectCwd(rootPath: string, ctx: CwdContext): CwdResult {
  const syn = checkSyntax(rootPath, ctx.platform)
  if (!syn.ok) return refuse(syn.code)
  const real = realDirectory(syn.path, ctx)
  if (!real.ok) return refuse(real.code)
  if (isFilesystemRoot(real.path, ctx.platform)) return refuse('cwd_outside')
  return { ok: true, cwd: real.path, root: real.path }
}

/** The user's home as the default starting folder. */
export function resolveHomeCwd(ctx: CwdContext): CwdResult {
  const syn = checkSyntax(ctx.home, ctx.platform)
  if (!syn.ok) return refuse(syn.code)
  const real = realDirectory(syn.path, ctx)
  if (!real.ok) return refuse(real.code)
  return { ok: true, cwd: real.path, root: real.path }
}

/** The default file system: native realpath (8.3 names and canonical case on Windows). */
export const nodeCwdFs: CwdFs = {
  realpath: (p) => realpathSync.native(p),
  isDirectory: (p) => statSync(p).isDirectory(),
}
