/**
 * The environment a terminal child gets: the user's own environment (the daemon's, which was inherited from the
 * shell that started it) MINUS everything that belongs to the daemon.
 *
 * Why: a terminal runs arbitrary programs as the user, and so does anything those programs spawn. The daemon's
 * own secrets and control variables have no business in there: a project's dev server, an npm script or a
 * misbehaving tool would otherwise inherit them and could log or send them.
 *
 * The rule (documented in apps/daemon/README.md, "Terminal"):
 *   1. Prefixes owned by this product are removed whatever follows: DAEMON_*, AI_ASSISTANT_* (the hook token
 *      variable of `hooks install`), AIA_*, MIRA_*.
 *   2. Every variable of the daemon's own configuration table is removed: DATA_DIR, DEV_ORIGINS, WEB_DIST,
 *      CLAUDE_BACKEND, CLAUDE_AUTH_MODE, DEMO, LOG_LEVEL, RETENTION_DAYS, BUDGET_*, STALE_*, TERMINAL_*.
 *   3. ANTHROPIC_API_KEY is removed. The daemon reads it for its own chat lane (with a budget). The user's own
 *      `claude` in a terminal signs in by itself (subscription login, or a key the user sets inside that terminal),
 *      so the daemon never hands its key to it and never silently switches a subscription login to API billing.
 *   4. Token-shaped names with a daemon-flavoured prefix are removed: STAGE_*, HOOK_*, EXCHANGE_*, SESSION_*,
 *      COOKIE_* when the name ends in TOKEN, SECRET, CODE, KEY or PASSWORD (for example STAGE_TOKEN, HOOK_TOKEN,
 *      EXCHANGE_CODE), and X_HOOK_TOKEN / X_STAGE_TOKEN / X_EXCHANGE_CODE style names. AWS_SESSION_TOKEN and
 *      friends are the USER's credentials and stay (the match is anchored at the start of the name).
 *   5. Launcher artefacts: when the daemon was started with `pnpm start` / `npm run`, the package manager marked its
 *      environment ("we are inside an npm script"): npm_lifecycle_*, npm_package_*, npm_command, npm_execpath,
 *      npm_node_execpath, npm_config_user_agent, INIT_CWD, PNPM_SCRIPT_SRC_DIR. They would make tools in the terminal
 *      behave as if they ran inside that script, so they are removed. (Other npm_config_* settings stay.)
 *   6. Names that are not valid for a child process (empty, containing "=" after the first character, NUL) and
 *      Windows' hidden per-drive variables (names starting with "=") are dropped.
 *   7. Module loaders of the daemon's own launcher. The pnpm and tsx shims start the daemon with NODE_PATH pointing into
 *      the daemon's dependency tree, and a launcher may inject code with NODE_OPTIONS (--require, --import, --loader):
 *      any Node program started in the terminal would then resolve the daemon's packages or run the daemon's loader.
 *      NODE_PATH entries inside the daemon's own tree (the workspace, the daemon package, a pnpm virtual store) are
 *      removed and the user's own entries stay; NODE_OPTIONS loses only the code-loading flags (--require, -r, --import,
 *      --loader, --experimental-loader, with their values) and keeps the rest (--use-openssl-ca, --max-old-space-size...).
 *   CLAUDE_CONFIG_DIR and CLAUDE_EXECUTABLE are deliberately kept: they are the user's own Claude Code settings.
 *
 * On Windows names are case-insensitive, so every comparison is on the upper-cased name.
 */

import * as nodePath from 'node:path'

const OWNED_PREFIXES = ['DAEMON_', 'AI_ASSISTANT_', 'AIA_', 'MIRA_'] as const

const DAEMON_CONFIG_NAMES = new Set([
  'DATA_DIR',
  'DEV_ORIGINS',
  'WEB_DIST',
  'CLAUDE_BACKEND',
  'CLAUDE_AUTH_MODE',
  'DEMO',
  'LOG_LEVEL',
  'RETENTION_DAYS',
  'ANTHROPIC_API_KEY',
])
const DAEMON_CONFIG_PREFIXES = ['BUDGET_', 'STALE_', 'TERMINAL_'] as const

const LAUNCHER_NAMES = new Set(['NPM_COMMAND', 'NPM_EXECPATH', 'NPM_NODE_EXECPATH', 'NPM_CONFIG_USER_AGENT', 'INIT_CWD', 'PNPM_SCRIPT_SRC_DIR'])
const LAUNCHER_PREFIXES = ['NPM_LIFECYCLE_', 'NPM_PACKAGE_'] as const

const SECRET_SUFFIX = '(?:TOKEN|SECRET|CODE|KEY|PASSWORD)'
const TOKEN_AT_START = new RegExp(`^(?:STAGE|HOOK|EXCHANGE|SESSION|COOKIE)_[A-Z0-9_]*${SECRET_SUFFIX}$`)
const TOKEN_PREFIXED = new RegExp(`^[A-Z0-9_]+_(?:HOOK|STAGE|EXCHANGE)_${SECRET_SUFFIX}$`)

/** True when a variable belongs to the daemon (or is one of its secrets) and must not reach a terminal child. */
export function isDaemonInternalVar(name: string): boolean {
  const n = name.toUpperCase()
  if (OWNED_PREFIXES.some((p) => n.startsWith(p))) return true
  if (DAEMON_CONFIG_NAMES.has(n)) return true
  if (DAEMON_CONFIG_PREFIXES.some((p) => n.startsWith(p))) return true
  if (TOKEN_AT_START.test(n) || TOKEN_PREFIXED.test(n)) return true
  if (LAUNCHER_NAMES.has(n) || LAUNCHER_PREFIXES.some((p) => n.startsWith(p))) return true
  return false
}

/** True when `child` is `parent` or inside it. Separators and (on Windows) case are normalised; a filesystem root never counts. */
function insideDir(child: string, parent: string, platform: NodeJS.Platform): boolean {
  const f = platform === 'win32' ? nodePath.win32 : nodePath.posix
  const norm = (p: string): string => {
    const r = f.resolve(p)
    const t = r.length > 1 && /[\\/]$/.test(r) && f.parse(r).root !== r ? r.slice(0, -1) : r
    return platform === 'win32' ? t.toLowerCase() : t
  }
  if (!parent || !child || f.parse(f.resolve(parent)).root === f.resolve(parent)) return false
  const c = norm(child)
  const p = norm(parent)
  return c === p || c.startsWith(p.endsWith(f.sep) ? p : p + f.sep)
}

const PNPM_STORE = /[\\/]node_modules[\\/]\.pnpm[\\/]/

/** NODE_PATH without the entries that lead into the daemon's own dependency tree. Undefined when nothing is left. */
export function scrubNodePath(value: string, platform: NodeJS.Platform, daemonRoots: readonly string[]): string | undefined {
  const delimiter = platform === 'win32' ? ';' : ':'
  const kept = value
    .split(delimiter)
    .map((e) => e.trim())
    .filter((e) => e.length > 0 && !PNPM_STORE.test(e) && !daemonRoots.some((r) => insideDir(e, r, platform)))
  return kept.length > 0 ? kept.join(delimiter) : undefined
}

/** Split NODE_OPTIONS into tokens the way Node does (whitespace, double quotes group), keeping each token's raw text. */
function optionTokens(value: string): string[] {
  const out: string[] = []
  let cur = ''
  let quoted = false
  for (const ch of value) {
    if (ch === '"') {
      quoted = !quoted
      cur += ch
    } else if (!quoted && /\s/.test(ch)) {
      if (cur) out.push(cur)
      cur = ''
    } else cur += ch
  }
  if (cur) out.push(cur)
  return out
}

const CODE_LOADING_FLAGS = new Set(['--require', '-r', '--import', '--loader', '--experimental-loader'])

/** NODE_OPTIONS without the flags that load code (with their values). Undefined when nothing is left. */
export function scrubNodeOptions(value: string): string | undefined {
  const tokens = optionTokens(value)
  const kept: string[] = []
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i] as string
    const flag = t.split('=')[0] as string
    if (CODE_LOADING_FLAGS.has(flag)) {
      if (!t.includes('=')) i++ // the value is the next token
      continue
    }
    kept.push(t)
  }
  return kept.length > 0 ? kept.join(' ') : undefined
}

function isValidName(name: string): boolean {
  if (name.length === 0 || name.startsWith('=')) return false
  return !name.includes('=') && !name.includes('\0')
}

export interface TerminalEnvOptions {
  platform: NodeJS.Platform
  /** Added last (they win), for example a marker variable. Names that look daemon-internal are still refused. */
  extra?: Record<string, string>
  /**
   * Folders that belong to the daemon's own install (the workspace root, the daemon package): NODE_PATH entries inside
   * them are removed. A pnpm virtual store entry is removed whatever this says.
   */
  daemonRoots?: readonly string[]
}

/** The loader variables of rule 7: scrubbed in place (not simply dropped) so the user's own entries survive. */
function applyLoaderRules(name: string, value: string, platform: NodeJS.Platform, daemonRoots: readonly string[]): string | undefined {
  const n = name.toUpperCase()
  if (n === 'NODE_PATH') return scrubNodePath(value, platform, daemonRoots)
  if (n === 'NODE_OPTIONS') return scrubNodeOptions(value)
  return value
}

/**
 * Build the child environment. The result only contains string values. TERM and COLORTERM are set so colour-aware
 * programs (Claude Code's UI included) draw with 256 colours and truecolor, which xterm.js supports.
 */
export function buildTerminalEnv(parent: Readonly<Record<string, string | undefined>>, opts: TerminalEnvOptions): Record<string, string> {
  const out: Record<string, string> = {}
  const roots = opts.daemonRoots ?? []
  // On Windows the same variable can appear twice with different case in a copied environment; the last one wins in
  // the process, so keep one entry per upper-cased name and preserve the original spelling of the first.
  const seen = new Map<string, string>()
  for (const [name, rawValue] of Object.entries(parent)) {
    if (typeof rawValue !== 'string' || rawValue.includes('\0')) continue
    if (!isValidName(name)) continue
    if (isDaemonInternalVar(name)) continue
    const value = applyLoaderRules(name, rawValue, opts.platform, roots)
    if (opts.platform === 'win32') {
      const key = name.toUpperCase()
      const first = seen.get(key)
      if (first !== undefined) delete out[first]
      seen.set(key, name)
    }
    if (value === undefined) {
      if (opts.platform === 'win32') seen.delete(name.toUpperCase())
      continue
    }
    out[name] = value
  }
  const set = (name: string, value: string): void => {
    if (opts.platform === 'win32') {
      const existing = seen.get(name.toUpperCase())
      if (existing !== undefined && existing !== name) delete out[existing]
      seen.set(name.toUpperCase(), name)
    }
    out[name] = value
  }
  set('TERM', 'xterm-256color')
  set('COLORTERM', 'truecolor')
  for (const [name, value] of Object.entries(opts.extra ?? {})) {
    if (!isValidName(name) || isDaemonInternalVar(name) || value.includes('\0')) continue
    set(name, value)
  }
  return out
}

/**
 * The environment of a PTY HOST process (src/terminal/ptyHost.ts): the daemon's own, without anything secret or
 * daemon-internal (no ANTHROPIC_API_KEY, no hook or stage token variable, nothing of the configuration table), but WITH
 * the loader variables the daemon itself was started with (NODE_PATH from the pnpm shim, NODE_OPTIONS), because the host
 * is the same program under the same loader. The program the host starts gets the separate, fully scrubbed environment
 * that buildTerminalEnv made.
 */
export function buildHostEnv(parent: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(parent)) {
    if (typeof value !== 'string' || value.includes('\0') || !isValidName(name)) continue
    const n = name.toUpperCase()
    if (OWNED_PREFIXES.some((p) => n.startsWith(p)) || DAEMON_CONFIG_NAMES.has(n) || DAEMON_CONFIG_PREFIXES.some((p) => n.startsWith(p)) || TOKEN_AT_START.test(n) || TOKEN_PREFIXED.test(n)) continue
    out[name] = value
  }
  return out
}
